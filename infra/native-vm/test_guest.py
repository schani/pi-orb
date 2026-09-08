#!/usr/bin/python3
import importlib.util
import io
import json
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
supervisor = load('runtime_supervisor')


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
            self.assertEqual(target.read_text(), 'sentinel')
            self.assertFalse((runtime_dir / 'environment.new').exists())


class WorkspaceTest(unittest.TestCase):
    def make_disk(self):
        temporary = tempfile.NamedTemporaryFile()
        return temporary

    def test_same_size_ext4_skips_forced_check_and_resize(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        commands = []
        def command(argv):
            commands.append(argv)
            if 'blockdev' in argv[0]: return Result(stdout=str(50 * 1024 ** 3))
            if 'blkid' in argv[0]: return Result(stdout='ext4\n')
            if 'tune2fs' in argv[0]: return Result(stdout='Block count: 13107200\nBlock size: 4096\n')
            return Result()
        self.assertEqual(workspace.prepare(Path(disk.name), command), 'filesystem_size_current')
        self.assertFalse(any('mkfs' in argv[0] for argv in commands))
        self.assertFalse(any('e2fsck' in argv[0] for argv in commands))
        self.assertFalse(any('resize2fs' in argv[0] for argv in commands))

    def test_checks_and_grows_cloned_ext4_to_device(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        commands = []
        def command(argv):
            commands.append(argv)
            if 'blockdev' in argv[0]: return Result(stdout=str(50 * 1024 ** 3))
            if 'blkid' in argv[0]: return Result(stdout='ext4\n')
            if 'tune2fs' in argv[0]: return Result(stdout='Block count: 2621440\nBlock size: 4096\n')
            return Result()
        self.assertEqual(workspace.prepare(Path(disk.name), command), 'filesystem_grown')
        self.assertTrue(any('e2fsck' in argv[0] and '-n' in argv for argv in commands))
        self.assertTrue(any('resize2fs' in argv[0] for argv in commands))

    def test_missing_and_unsupported_filesystems_fail_closed_without_formatting(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        for filesystem, expected in ((None, 'missing_filesystem'), ('xfs', 'unsupported_filesystem')):
            commands = []
            def command(argv):
                commands.append(argv)
                if 'blockdev' in argv[0]: return Result(stdout=str(20 * 1024 ** 3))
                if 'blkid' in argv[0]: return Result(returncode=2) if filesystem is None else Result(stdout=filesystem)
                return Result()
            self.assertEqual(workspace.prepare(Path(disk.name), command), expected)
            self.assertFalse(any('mkfs' in argv[0] for argv in commands))

    def test_damaged_or_ungrowable_ext4_fails_closed(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        def commands_with(failing):
            def command(argv):
                if 'blockdev' in argv[0]: return Result(stdout=str(20 * 1024 ** 3))
                if 'blkid' in argv[0]: return Result(stdout='ext4')
                if 'tune2fs' in argv[0]: return Result(stdout='Block count: 2621440\nBlock size: 4096\n')
                return Result(returncode=4 if failing in argv[0] else 0)
            return command
        self.assertEqual(workspace.prepare(Path(disk.name), commands_with('e2fsck')), 'filesystem_check_failed')
        self.assertEqual(workspace.prepare(Path(disk.name), commands_with('resize2fs')), 'filesystem_resize_failed')

    def test_invalid_ext4_metadata_fails_closed_without_repair(self):
        disk = self.make_disk()
        self.addCleanup(disk.close)
        commands = []
        def command(argv):
            commands.append(argv)
            if 'blockdev' in argv[0]: return Result(stdout=str(20 * 1024 ** 3))
            if 'blkid' in argv[0]: return Result(stdout='ext4')
            if 'tune2fs' in argv[0]: return Result(stdout='invalid')
            return Result()
        self.assertEqual(workspace.prepare(Path(disk.name), command), 'filesystem_size_invalid')
        self.assertFalse(any('e2fsck' in argv[0] or 'resize2fs' in argv[0] for argv in commands))

    def test_acceptance_requires_filesystem_to_fill_the_device(self):
        acceptance = (ROOT / 'acceptance.sh').read_text()
        self.assertIn('blockdev --getsize64', acceptance)
        self.assertIn('device_bytes - filesystem_bytes', acceptance)
        self.assertIn('-lt "$block_size"', acceptance)

    def test_main_publishes_exact_failure_code(self):
        with patch.object(workspace, 'wait_for_device', return_value=True), patch.object(workspace, 'prepare', return_value='missing_filesystem'), patch.object(workspace.subprocess, 'run') as run:
            self.assertEqual(workspace.main(), 1)
        self.assertEqual(
            run.call_args.args[0],
            ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'failed', 'missing_filesystem'],
        )

    def test_main_publishes_the_workspace_size_decision(self):
        for result in ('filesystem_size_current', 'filesystem_grown'):
            with patch.object(workspace, 'wait_for_device', return_value=True), patch.object(workspace, 'prepare', return_value=result), patch.object(workspace.subprocess, 'run') as run:
                self.assertEqual(workspace.main(), 0)
            self.assertEqual(
                run.call_args.args[0],
                ['/usr/local/bin/pi-orb-boot-diagnostic', 'workspace', 'ready', result],
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


class RuntimeSupervisorTest(unittest.TestCase):
    class Child:
        pid = 123
        returncode = None
        def poll(self): return None
        def wait(self): return 0

    def test_reports_ready_after_typed_health(self):
        records = []
        child = self.Child()
        with patch.object(supervisor, 'report', side_effect=lambda *value: records.append(value)):
            self.assertEqual(supervisor.main(health_check=lambda: ('ready', None), popen=lambda *args, **kwargs: child), 0)
        self.assertEqual(records, [('ready',)])

    def test_long_setup_does_not_create_a_supervisor_deadline(self):
        records = []
        statuses = iter([('initializing', None)] * 301 + [('setup_running', None)] * 301 + [('ready', None)])
        sleeps = []
        with patch.object(supervisor, 'report', side_effect=lambda *value: records.append(value)):
            self.assertEqual(supervisor.main(health_check=lambda: next(statuses), sleep=sleeps.append, popen=lambda *args, **kwargs: self.Child()), 0)
        self.assertEqual(len(sleeps), 602)
        self.assertEqual(records, [('ready',)])

    def test_reports_only_bounded_failure_code(self):
        records = []
        with patch.object(supervisor, 'report', side_effect=lambda *value: records.append(value)):
            self.assertEqual(supervisor.main(health_check=lambda: ('failed', 'clone_failed'), popen=lambda *args, **kwargs: self.Child()), 0)
        self.assertEqual(records, [('failed', 'clone_failed')])

    def test_reports_exit_code_before_readiness(self):
        child = self.Child()
        child.poll = lambda: 23
        child.returncode = 23
        records = []
        with patch.object(supervisor, 'report', side_effect=lambda *value: records.append(value)):
            self.assertEqual(supervisor.main(popen=lambda *args, **kwargs: child), 0)
        self.assertEqual(records, [('failed', 'runtime_exited_before_ready', {'exitCode': 23})])

    def test_forwards_sigterm_to_child_process_group(self):
        handlers = {}
        forwarded = []
        child = self.Child()
        def health_check():
            handlers[supervisor.signal.SIGTERM](supervisor.signal.SIGTERM, None)
            return 'ready', None
        with patch.object(supervisor, 'report'):
            self.assertEqual(supervisor.main(health_check=health_check, popen=lambda *args, **kwargs: child, install_signal=lambda signum, handler: handlers.update({signum: handler}), killpg=lambda *args: forwarded.append(args)), 0)
        self.assertEqual(forwarded, [(123, supervisor.signal.SIGTERM)])


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

    def test_event_is_logged_without_overwriting_boot_status(self):
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
        record = diagnostic.rust_event(
            'rust_toolchain_retry', '',
            '{"attempt":2,"delayMs":5000,"errorClass":"dns"}',
        )
        self.assertIsNotNone(record)
        diagnostic.publish(record, opened, write_attribute=False)
        self.assertEqual([request.full_url for request in requests], [diagnostic.LOGGING_URL])
        logged = json.loads(requests[0].data)['entries'][0]['jsonPayload']
        self.assertEqual(logged['status'], 'event')
        self.assertEqual(logged['code'], 'rust_toolchain_retry')
        self.assertEqual(logged['details']['errorClass'], 'dns')

    def test_runtime_events_are_bounded_and_structured(self):
        records = []
        with patch.object(diagnostic, 'publish', side_effect=lambda record, **kwargs: records.append((record, kwargs))):
            self.assertEqual(diagnostic.main([
                'runtime', 'event', 'rust_toolchain_recovered', '', '{"attempt":3}',
            ]), 0)
        self.assertEqual(records[0][0]['details']['attempt'], 3)
        self.assertEqual(records[0][1], {'write_attribute': False})
        invalid = (
            ['runtime', 'event', 'other', '', '{"attempt":2}'],
            ['runtime', 'event', 'rust_toolchain_retry', 'raw error', '{"attempt":2,"delayMs":5000,"errorClass":"dns"}'],
            ['runtime', 'event', 'rust_toolchain_retry', '', '{"attempt":2,"delayMs":5000,"errorClass":"secret"}'],
            ['runtime', 'event', 'rust_toolchain_recovered', '', '{"attempt":3,"extra":"value"}'],
        )
        for arguments in invalid:
            self.assertEqual(diagnostic.main(arguments), 2)

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


if __name__ == '__main__':
    unittest.main()
