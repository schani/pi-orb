#!/usr/bin/python3
import importlib.util
import io
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bootstrap = load('bootstrap')
diagnostic = load('boot_diagnostic')
workspace = load('prepare_workspace')


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class Result:
    def __init__(self, returncode=0, stdout=''):
        self.returncode = returncode
        self.stdout = stdout


class BootstrapTest(unittest.TestCase):
    def config(self):
        return {
            'PI_ORB_ID': 'orb', 'PI_ORB_RUNTIME_TOKEN': 'secret',
            'PI_ORB_CONTROL_PLANE_URL': 'https://control',
            'PI_ORB_HOST_INCARNATION': '2',
            'PI_ORB_REPOSITORY_URL': 'https://github.com/o/r',
            'PI_ORB_SKILLS_DIR': '/opt/pi-orb/skills',
            'QUOTED': 'a"b\\c',
        }

    def test_writes_private_environment_and_durable_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'workspace').mkdir()
            opened = lambda request, timeout: Response(json.dumps(self.config()).encode())
            result = bootstrap.main(opened, root / 'workspace', root / 'run', lambda _: True, lambda *_: None)
            self.assertEqual(result, 0)
            environment = (root / 'run/environment')
            self.assertEqual(environment.stat().st_mode & 0o777, 0o600)
            self.assertIn('QUOTED="a\\"b\\\\c"', environment.read_text())
            self.assertIn('HOME="' + str(root / 'workspace/home') + '"', environment.read_text())
            self.assertEqual((root / 'workspace/home').stat().st_mode & 0o777, 0o700)

    def test_repository_is_optional_without_weakening_runtime_authentication(self):
        for repository_url in ('', None):
            config = self.config()
            if repository_url is None:
                del config['PI_ORB_REPOSITORY_URL']
            else:
                config['PI_ORB_REPOSITORY_URL'] = repository_url
            with self.subTest(repository_url=repository_url), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / 'workspace').mkdir()
                opened = lambda request, timeout: Response(json.dumps(config).encode())
                self.assertEqual(bootstrap.main(opened, root / 'workspace', root / 'run', lambda _: True, lambda *_: None), 0)
                environment = (root / 'run/environment').read_text()
                self.assertIn('PI_ORB_RUNTIME_TOKEN="secret"', environment)
                self.assertIn('PI_ORB_CONTROL_PLANE_URL="https://control"', environment)
                for key in ('PI_ORB_RUNTIME_TOKEN', 'PI_ORB_CONTROL_PLANE_URL'):
                    with self.subTest(required=key), self.assertRaisesRegex(ValueError, key):
                        bad = {**config, key: ''}
                        bootstrap.load_config(lambda request, timeout: Response(json.dumps(bad).encode()))

    def fake_clock(self):
        now = [0.0]
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds
        return sleeps, sleep, lambda: now[0]

    def test_retries_transient_metadata_failure_and_records_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'workspace').mkdir()
            failures = [bootstrap.urllib.error.URLError(OSError(101, 'Network is unreachable')), bootstrap.urllib.error.HTTPError(bootstrap.METADATA_CONFIG_URL, 503, 'Service Unavailable', {}, io.BytesIO())]

            def opened(request, timeout):
                if failures:
                    raise failures.pop(0)
                return Response(json.dumps(self.config()).encode())
            sleeps, sleep, monotonic = self.fake_clock()
            commands = []
            with patch('sys.stderr', new_callable=io.StringIO) as stderr:
                result = bootstrap.main(opened, root / 'workspace', root / 'run', lambda _: True, lambda *_: None, sleep, monotonic, lambda argv, **_: commands.append(argv))
            self.assertEqual(result, 0)
            self.assertEqual(sleeps, [0.5, 1])
            self.assertIn('metadata_retry 1: <urlopen error [Errno 101] Network is unreachable>', stderr.getvalue())
            self.assertIn('metadata_retry 2: HTTP Error 503: Service Unavailable', stderr.getvalue())
            self.assertEqual(commands, [[bootstrap.DIAGNOSTIC, 'bootstrap', 'starting', 'metadata_retried', 'HTTP Error 503: Service Unavailable', '{"metadataRetries": 2}']])
            self.assertTrue((root / 'run/environment').exists())
            records = []
            with patch.object(diagnostic, 'publish', records.append):
                self.assertEqual(diagnostic.main(commands[0][1:]), 0)
            self.assertEqual((records[0]['code'], records[0]['details']['metadataRetries']), ('metadata_retried', 2))

    def test_gives_up_on_persistent_transient_failure_within_budget(self):
        attempts = []

        def opened(request, timeout):
            attempts.append(request.full_url)
            raise bootstrap.urllib.error.URLError(OSError(101, 'Network is unreachable'))
        sleeps, sleep, monotonic = self.fake_clock()
        commands = []
        with patch('sys.stderr', new_callable=io.StringIO) as stderr:
            result = bootstrap.main(opened, Path('/workspace'), Path('/run/pi-orb'), lambda _: True, lambda *_: None, sleep, monotonic, lambda argv, **_: commands.append(argv))
        self.assertEqual(result, 1)
        self.assertEqual(sleeps, [0.5, 1, 2, 4, 8, 8, 8, 8, 8, 8])
        self.assertLessEqual(sum(sleeps), bootstrap.METADATA_RETRY_BUDGET_SECONDS)
        self.assertEqual(len(attempts), 11)
        self.assertEqual(commands, [])
        self.assertTrue(stderr.getvalue().endswith('<urlopen error [Errno 101] Network is unreachable>\n'))

    def test_missing_configuration_fails_without_retry(self):
        attempts = []

        def opened(request, timeout):
            attempts.append(request.full_url)
            raise bootstrap.urllib.error.HTTPError(bootstrap.METADATA_CONFIG_URL, 404, 'Not Found', {}, io.BytesIO())
        sleeps, sleep, monotonic = self.fake_clock()
        with patch('sys.stderr', new_callable=io.StringIO) as stderr:
            result = bootstrap.main(opened, Path('/workspace'), Path('/run/pi-orb'), lambda _: True, lambda *_: None, sleep, monotonic, lambda *_: self.fail('no retry edge'))
        self.assertEqual(result, 1)
        self.assertEqual((len(attempts), sleeps), (1, []))
        self.assertTrue(stderr.getvalue().startswith('HTTP Error 404: Not Found\n'))
        self.assertNotIn('metadata_retry', stderr.getvalue())

    def test_rejects_missing_disk_before_fetching_metadata(self):
        opened = lambda *_: self.fail('metadata must not be read')
        self.assertEqual(bootstrap.main(opened, Path('/workspace'), Path('/run/pi-orb'), lambda _: False), 1)

    def test_rejects_injection_and_missing_required_values(self):
        for bad in ({**self.config(), 'BAD\nKEY': 'x'}, {**self.config(), 'PI_ORB_RUNTIME_TOKEN': ''}, ['not-an-object']):
            opened = lambda request, timeout, value=bad: Response(json.dumps(value).encode())
            with self.assertRaises(ValueError):
                bootstrap.load_config(opened)

    def test_rejects_missing_skills_directory_configuration(self):
        config = self.config()
        del config['PI_ORB_SKILLS_DIR']
        opened = lambda request, timeout: Response(json.dumps(config).encode())
        with self.assertRaisesRegex(ValueError, 'PI_ORB_SKILLS_DIR'):
            bootstrap.load_config(opened)

    def test_rejects_user_controlled_home_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace_dir = root / 'workspace'
            workspace_dir.mkdir()
            target = root / 'target'
            target.mkdir()
            (workspace_dir / 'home').symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'persistent home'):
                bootstrap.write_environment(self.config(), workspace_dir, root / 'run', lambda *_: None)

    def test_replaces_stale_temporary_environment_without_following_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace_dir = root / 'workspace'
            workspace_dir.mkdir()
            runtime_dir = root / 'run'
            runtime_dir.mkdir()
            target = root / 'must-not-change'
            target.write_text('sentinel')
            (runtime_dir / 'environment.new').symlink_to(target)
            bootstrap.write_environment(self.config(), workspace_dir, runtime_dir, lambda *_: None)
            self.assertIn('PI_ORB_CONTAINER="1"', (runtime_dir / 'environment').read_text())
            self.assertEqual(target.read_text(), 'sentinel')
            self.assertFalse((runtime_dir / 'environment.new').exists())


class WorkspaceTest(unittest.TestCase):
    def make_disk(self):
        temporary = tempfile.NamedTemporaryFile()
        return temporary

    def test_fixed_size_ext4_admission_only_reads_metadata(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        commands = []
        def command(argv):
            commands.append(argv)
            if 'blockdev' in argv[0]: return Result(stdout=str(50 * 1024 ** 3))
            if 'blkid' in argv[0]: return Result(stdout='ext4\n')
            if 'tune2fs' in argv[0]: return Result(stdout='Block count: 13107200\nBlock size: 4096\n')
            return Result()
        self.assertEqual(workspace.prepare(Path(disk.name), command), 'filesystem_ready')
        self.assertFalse(any('mkfs' in argv[0] for argv in commands))
        self.assertFalse(any('e2fsck' in argv[0] for argv in commands))
        self.assertFalse(any('resize2fs' in argv[0] for argv in commands))

    def test_smaller_and_larger_filesystems_are_refused_without_mutation(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        for blocks in (2621440, 15728640):
            commands = []
            def command(argv):
                commands.append(argv)
                if 'blockdev' in argv[0]: return Result(stdout=str(50 * 1024 ** 3))
                if 'blkid' in argv[0]: return Result(stdout='ext4\n')
                if 'tune2fs' in argv[0]: return Result(stdout=f'Block count: {blocks}\nBlock size: 4096\n')
                self.fail(f'unexpected command: {argv}')
            self.assertEqual(workspace.prepare(Path(disk.name), command), 'filesystem_size_mismatch')
            self.assertEqual(len(commands), 3)

    def test_unsupported_disk_capacities_are_refused_before_filesystem_inspection(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        for gib in (10, 20, 49, 51, 100):
            commands = []
            def command(argv):
                commands.append(argv)
                return Result(stdout=str(gib * 1024 ** 3))
            self.assertEqual(workspace.prepare(Path(disk.name), command), 'disk_size_mismatch')
            self.assertEqual(len(commands), 1)

    def test_missing_and_unsupported_filesystems_fail_closed_without_formatting(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        for filesystem, expected in ((None, 'missing_filesystem'), ('xfs', 'unsupported_filesystem')):
            commands = []
            def command(argv):
                commands.append(argv)
                if 'blockdev' in argv[0]: return Result(stdout=str(50 * 1024 ** 3))
                if 'blkid' in argv[0]: return Result(returncode=2) if filesystem is None else Result(stdout=filesystem)
                return Result()
            self.assertEqual(workspace.prepare(Path(disk.name), command), expected)
            self.assertFalse(any('mkfs' in argv[0] for argv in commands))

    def test_invalid_ext4_metadata_fails_closed_without_repair(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        commands = []
        def command(argv):
            commands.append(argv)
            if 'blockdev' in argv[0]: return Result(stdout=str(50 * 1024 ** 3))
            if 'blkid' in argv[0]: return Result(stdout='ext4')
            if 'tune2fs' in argv[0]: return Result(stdout='invalid')
            return Result()
        self.assertEqual(workspace.prepare(Path(disk.name), command), 'filesystem_size_invalid')
        self.assertFalse(any('e2fsck' in argv[0] or 'resize2fs' in argv[0] for argv in commands))

    def test_acceptance_requires_filesystem_to_fill_the_device(self):
        acceptance = (ROOT / 'acceptance.sh').read_text()
        self.assertIn('blockdev --getsize64', acceptance)
        self.assertIn('test "$device_bytes" -eq $((50 * 1024 * 1024 * 1024))', acceptance)
        self.assertIn('test "$filesystem_bytes" -eq "$device_bytes"', acceptance)

    def test_main_publishes_exact_failure_code(self):
        with patch.object(workspace, 'wait_for_device', return_value=True), patch.object(workspace, 'prepare', return_value='missing_filesystem'), patch.object(workspace.subprocess, 'run') as run:
            self.assertEqual(workspace.main(), 1)
        self.assertEqual(
            run.call_args.args[0],
            ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'failed', 'missing_filesystem'],
        )

    def test_main_publishes_workspace_ready(self):
        with patch.object(workspace, 'wait_for_device', return_value=True), patch.object(workspace, 'prepare', return_value='filesystem_ready'), patch.object(workspace.subprocess, 'run') as run:
            self.assertEqual(workspace.main(), 0)
        self.assertEqual(
            run.call_args.args[0],
            ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'ready', 'filesystem_ready'],
        )

    def test_missing_device_times_out_without_probing_or_formatting(self):
        with patch.object(workspace, 'wait_for_device', return_value=False), patch.object(workspace, 'prepare') as prepare, patch.object(workspace.subprocess, 'run') as run:
            self.assertEqual(workspace.main(), 1)
        prepare.assert_not_called()
        self.assertEqual(run.call_args.args[0][-1], 'workspace_device_timeout')

    def test_device_wait_is_bounded(self):
        ticks = iter((0, 0, 1, 2))
        sleeps = []
        self.assertFalse(workspace.wait_for_device(Path('/missing'), timeout=2, monotonic=lambda: next(ticks), sleep=sleeps.append))
        self.assertEqual(sleeps, [1, 1])


class DiagnosticTest(unittest.TestCase):
    def test_workspace_mount_avoids_local_filesystem_boot_cycle(self):
        unit = (ROOT / 'workspace.mount').read_text()
        self.assertIn('DefaultDependencies=no', unit)
        self.assertIn('Conflicts=umount.target', unit)
        self.assertIn('Before=pi-orb-bootstrap.service docker.service containerd.service umount.target', unit)

    def test_reports_workspace_capacity_only_after_mount(self):
        filesystem = type('Filesystem', (), {'f_bavail': 2, 'f_frsize': 4096})()
        with patch.object(diagnostic.os.path, 'ismount', return_value=False), patch.object(diagnostic.os, 'statvfs', return_value=filesystem):
            self.assertEqual(diagnostic.filesystem_details(), {'bootFreeBytes': 8192})
        with patch.object(diagnostic.os.path, 'ismount', return_value=True), patch.object(diagnostic.os, 'statvfs', return_value=filesystem):
            self.assertEqual(diagnostic.filesystem_details(), {'bootFreeBytes': 8192, 'workspaceFreeBytes': 8192})

    def test_publishes_same_structured_edge_to_both_sinks(self):
        requests = []
        def opened(request, timeout):
            if request.full_url == diagnostic.INSTANCE_ID_URL:
                return Response(b'123')
            if request.full_url == diagnostic.ZONE_URL:
                return Response(b'projects/p/zones/us-central1-a')
            if request.full_url == diagnostic.PROJECT_ID_URL:
                return Response(b'project')
            if request.full_url == diagnostic.TOKEN_URL:
                return Response(b'{"access_token":"vm-token"}')
            requests.append(request)
            return Response()
        record = diagnostic.payload('workspace', 'failed', 'mount_failed', 'line one\nsecretless')
        diagnostic.publish(record, opened)
        guest_record = json.loads(requests[0].data)
        logging_request = requests[1]
        logging_body = json.loads(logging_request.data)
        log_record = logging_body['entries'][0]['jsonPayload']
        self.assertEqual(logging_request.full_url, diagnostic.LOGGING_URL)
        self.assertEqual(logging_request.headers['Authorization'], 'Bearer vm-token')
        self.assertEqual(logging_body['logName'], 'projects/project/logs/pi-orb-boot')
        self.assertEqual(logging_body['resource']['labels']['instance_id'], '123')
        self.assertEqual(guest_record, log_record)
        self.assertEqual(guest_record['instanceId'], '123')
        self.assertEqual(guest_record['zone'], 'us-central1-a')
        self.assertEqual(guest_record['message'], 'line one secretless')
        self.assertEqual(logging_body['entries'][0]['severity'], 'ERROR')

    def test_logging_failure_does_not_hide_primary_failure(self):
        def fail(*_args, **_kwargs):
            raise OSError('offline')
        diagnostic.publish(diagnostic.payload('runtime', 'failed'), fail)

    def test_unit_name_maps_to_contract_phase(self):
        records = []
        with patch.object(diagnostic, 'publish', records.append):
            self.assertEqual(diagnostic.main(['pi-orb-workspace.service', 'failed', 'unit_failed']), 0)
        self.assertEqual(records[0]['phase'], 'workspace')

    def test_rejects_unknown_phase_and_bounds_public_text(self):
        self.assertEqual(diagnostic.main(['other', 'failed']), 2)
        record = diagnostic.payload('bootstrap', 'failed', 'x' * 100, 'y' * 600)
        self.assertEqual(len(record['code']), 80)
        self.assertEqual(len(record['message']), 500)

    def test_unit_failure_publishes_systemd_fields_and_separate_journal(self):
        records = []
        def command(argv, **_kwargs):
            if argv[0].endswith('systemctl'):
                return Result(stdout='Result=oom-kill\nNRestarts=3\nExecMainCode=2\nExecMainStatus=9\n')
            return Result(stdout='bounded runtime output')
        with patch.object(diagnostic, 'publish', side_effect=lambda record, **kwargs: records.append((record, kwargs))):
            self.assertEqual(diagnostic.publish_unit_failure('pi-orb-runtime.service', command, lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError())), 0)
        self.assertEqual(records[0][0]['code'], 'runtime_oom_kill')
        self.assertEqual(records[0][0]['details']['execMainStatus'], '9')
        self.assertEqual(records[1][0]['kind'], 'journal')
        self.assertEqual(records[1][1], {'write_attribute': False})

    def test_unit_failure_preserves_an_exact_workspace_failure(self):
        records = []
        existing = Response(b'{"schemaVersion":1,"phase":"workspace","status":"failed","code":"disk_not_blank"}')
        with patch.object(diagnostic, 'publish', side_effect=lambda record, **kwargs: records.append((record, kwargs))):
            self.assertEqual(diagnostic.publish_unit_failure('workspace.mount', lambda *_args, **_kwargs: Result(stdout='Result=success\n'), lambda *_args, **_kwargs: existing), 0)
        self.assertEqual(records[0][1], {'write_attribute': False})
        self.assertEqual(records[1][1], {'write_attribute': False})


    def test_runtime_events_are_log_only_and_skip_filesystem_sampling(self):
        details = {'exitCode': 1, 'signal': 9, 'requestedStop': False,
                   'runtimeInstanceId': 'runtime-1', 'lastLocalSuccessAt': None,
                   'error': 'Bearer secret', 'argv': ['secret'], 'childRssBytes': 123}
        with patch.object(diagnostic, 'filesystem_details', side_effect=AssertionError('disk access')), \
             patch.object(diagnostic, 'publish', return_value=True) as publish:
            self.assertEqual(diagnostic.main(['runtime-event', 'runtime_child_exited', json.dumps(details)]), 0)
        record = publish.call_args.args[0]
        self.assertEqual(publish.call_args.kwargs, {'write_attribute': False})
        self.assertEqual(record['kind'], 'runtime_event')
        self.assertEqual(record['details'], {key: details[key] for key in (
            'exitCode', 'signal', 'requestedStop', 'runtimeInstanceId', 'lastLocalSuccessAt')})
        self.assertNotIn('secret', json.dumps(record))

    def test_runtime_event_validates_fixed_typed_fields(self):
        valid = {'exitCode': 1, 'signal': 9, 'requestedStop': True, 'lastLocalSuccessAt': 123,
                 'probeElapsedMs': 2000.5, 'probeDeadlineMs': 2000,
                 'runtimeInstanceId': 'runtime-1', 'healthFailure': 'transport'}
        self.assertEqual(diagnostic.runtime_details(valid), valid)
        for value in (True, -1, float('nan'), float('inf'), 'secret', 10**400):
            self.assertEqual(diagnostic.runtime_details({'probeElapsedMs': value}), {})
        self.assertEqual(diagnostic.runtime_details({'exitCode': 1.5, 'signal': 9.5}), {})
        self.assertEqual(diagnostic.runtime_details({'runtimeInstanceId': 'secret space',
                         'requestedStop': 'yes', 'healthFailure': ['secret']}), {})
        with patch.object(diagnostic, 'publish') as publish:
            for args in (['secret', '{}'], ['runtime_health_failed', '[]'], ['runtime_health_failed', 'invalid']):
                self.assertEqual(diagnostic.main(['runtime-event', *args]), 2)
            publish.assert_not_called()

    def test_runtime_event_status_does_not_replace_boot_readiness(self):
        cases = [('runtime_health_failed', {}, 'failed'),
                 ('runtime_health_recovered', {}, 'recovered'),
                 ('runtime_child_exited', {'exitCode': 0}, 'stopped'),
                 ('runtime_child_exited', {'signal': 15, 'requestedStop': True}, 'stopped'),
                 ('runtime_child_exited', {'signal': 9}, 'failed')]
        for code, details, status in cases:
            with self.subTest(code=code, details=details), patch.object(diagnostic, 'publish', return_value=True) as publish:
                self.assertEqual(diagnostic.main(['runtime-event', code, json.dumps(details)]), 0)
                self.assertEqual(publish.call_args.args[0]['status'], status)

    def test_runtime_export_failure_is_sanitized(self):
        with patch.object(diagnostic, 'publish', return_value=False), patch('sys.stderr', new_callable=io.StringIO) as stderr:
            self.assertEqual(diagnostic.main(['runtime-event', 'runtime_health_failed', '{}']), 1)
        self.assertEqual(stderr.getvalue(), 'pi-orb diagnostic export_failed stage=runtime_event\n')

    def test_runtime_export_reuses_existing_publisher_without_guest_attribute(self):
        requests = []
        def opened(request, timeout):
            requests.append(request)
            if request.full_url == diagnostic.TOKEN_URL:
                return Response(b'{"access_token":"secret"}')
            if request.full_url == diagnostic.LOGGING_URL:
                raise OSError('Bearer secret request body')
            return Response(b'123')
        original = diagnostic.publish
        with patch.object(diagnostic, 'publish', side_effect=lambda record, **kwargs: original(record, opened, **kwargs)), \
             patch('sys.stderr', new_callable=io.StringIO) as stderr:
            self.assertEqual(diagnostic.main(['runtime-event', 'runtime_health_failed', '{}']), 1)
        self.assertNotIn(diagnostic.ATTRIBUTE_URL, [request.full_url for request in requests])
        self.assertEqual(requests[-1].full_url, diagnostic.LOGGING_URL)
        self.assertNotIn('secret', stderr.getvalue())
        entry = json.loads(requests[-1].data)['entries'][0]
        self.assertEqual(entry['severity'], 'ERROR')
        self.assertEqual(entry['jsonPayload']['instanceId'], '123')

class AcceptanceDiskTest(unittest.TestCase):
    def test_requires_workspace_mount_and_exact_canonical_device(self):
        source = (ROOT / 'acceptance.sh').read_text()
        block = source[source.index('test "$(findmnt '):source.index('filesystem_metadata=')]
        for mount, mounted, expected, accepted in [
            ('/', '/dev/root', '/dev/data', False),
            ('/workspace', '/dev/wrong', '/dev/data', False),
            ('/workspace', '/dev/data', '/dev/data', True),
        ]:
            with self.subTest(mount=mount, mounted=mounted):
                fixture = """
findmnt() {
  case "$*" in
    *TARGET*) printf '%s\n' "$MOUNT" ;;
    *) printf '%s\n' "$DEVICE" ;;
  esac
}
readlink() {
  case "$2" in
    /dev/disk/by-id/google-pi-orb-data) printf '%s\n' "$EXPECTED" ;;
    *) printf '%s\n' "$2" ;;
  esac
}
"""
                result = subprocess.run(['bash', '-ec', fixture + block],
                    env={'MOUNT': mount, 'DEVICE': mounted, 'EXPECTED': expected},
                    capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)


if __name__ == '__main__':
    unittest.main()
