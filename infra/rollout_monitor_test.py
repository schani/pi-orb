import copy
import io
import json
import os
import select
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from infra.release_state import Result, fail, save, validate_record
from infra.release_state_test import record as release_record
from infra import rollout_monitor as monitor


class MonitorTest(unittest.TestCase):
    def test_workflow_monitor_survives_the_deploying_orb(self):
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('python3 -m infra.rollout_monitor', workflow)
        self.assertIn('rollout-monitor-${{ github.run_id }}-${{ github.run_attempt }}', workflow)
        self.assertIn('if: always()', workflow.split('- name: Upload rollout monitor')[1])

    def test_monitor_starts_after_activation_and_joins_before_completion(self):
        source = Path('infra/release.sh').read_text()
        tail = source[source.index('stage activate'):]
        self.assertLess(tail.index('state activate'), tail.index('infra.rollout_monitor --active'))
        self.assertLess(tail.index('infra.rollout_monitor --active'), tail.index('stage lifecycle'))
        self.assertLess(tail.index('release_wait_child "$monitor_pid"'), tail.index('stage complete'))
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('PI_ORB_ROLLOUT_MONITOR_BASELINE:', workflow)
        self.assertIn('PI_ORB_ROLLOUT_MONITOR_OUTPUT:', workflow)
        self.assertIn('infra.rollout_monitor --verify', workflow)
        self.assertNotIn('Observe central rollout independently for fifteen minutes', workflow)

    def test_owned_monitor_overlaps_both_smokes_and_cleanup_joins_every_child(self):
        tail = Path('infra/release.sh').read_text().split('stage activate', 1)[1]
        for mode, expected in [('success', 0), ('monitor-failed', 17),
                               ('lifecycle-failed', 18), ('identity-failed', 19), ('cancel', 143)]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for name in ('monitor', 'lifecycle', 'identity'):
                    os.mkfifo(root / (name + '.fifo'))
                scripts = {
                    'python3': 'exec "$CONTROL/monitor.sh"\n',
                    'jq': 'echo fixture-value\n',
                    'monitor.sh': '''
trap 'echo monitor-stopped; exit 143' TERM
trap 'echo monitor-cleanup' EXIT
exec 7<> "$CONTROL/monitor.fifo"
echo monitor-start
read -r phase <&7
echo monitor-lifecycle-overlap
echo ready > "$CONTROL/lifecycle.fifo"
read -r phase <&7
echo monitor-identity-overlap
echo ready > "$CONTROL/identity.fifo"
read -r phase <&7
echo monitor-finish
if [ "$MODE" = monitor-failed ]; then exit 17; fi
''',
                    'smoke.sh': '''
trap 'exit 143' TERM
trap 'echo lifecycle-cleanup' EXIT
exec 7<> "$CONTROL/lifecycle.fifo"
echo lifecycle-start
echo lifecycle > "$CONTROL/monitor.fifo"
read -r ready <&7
if [ "$MODE" = lifecycle-failed ]; then exit 18; fi
if [ "$MODE" = cancel ]; then kill -TERM "$PPID"; read -r stopped <&7; fi
echo lifecycle-finish
''',
                    'smoke-workload-identity.sh': '''
trap 'exit 143' TERM
trap 'echo identity-cleanup' EXIT
exec 7<> "$CONTROL/identity.fifo"
echo identity-start
echo identity > "$CONTROL/monitor.fifo"
read -r ready <&7
if [ "$MODE" = identity-failed ]; then exit 19; fi
echo identity-finish
echo finished > "$CONTROL/monitor.fifo"
''',
                }
                for name, script in scripts.items():
                    path = root / name
                    path.write_text('#!/bin/bash\nset -eu\n' + script)
                    path.chmod(0o700)
                preamble = '''
set -euo pipefail
source "$CHILD_HELPER"
cleanup() {
  local status=$?
  trap - EXIT TERM
  release_stop_children
  echo cleanup:$status
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
state() { echo "state:$*"; }
stage() { echo "stage:$*"; }
INFRA=$CONTROL
RECORD=$CONTROL/release.json
VALIDATE=""
REMOTE_LOCK_GENERATION=7
PROJECT=project
ZONE=zone
foundation='{}'
PI_ORB_ROLLOUT_MONITOR_BASELINE=$CONTROL/baseline.json
PI_ORB_ROLLOUT_MONITOR_OUTPUT=$CONTROL/monitor.json
'''
                process = subprocess.Popen(['bash', '-c', preamble + tail], text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                    env={**os.environ, 'CONTROL': directory, 'MODE': mode,
                    'CHILD_HELPER': str(Path('infra/release-child.sh').resolve()),
                    'PATH': directory + os.pathsep + os.environ['PATH']})
                try:
                    stdout, stderr = process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    stdout, stderr = process.communicate()
                    self.fail('release checkpoint deadlock: ' + stdout + stderr)
                self.assertEqual(process.returncode, expected, stdout + stderr)
                events = stdout.splitlines()
                self.assertIn('monitor-cleanup', events)
                self.assertIn('lifecycle-cleanup', events)
                self.assertLess(events.index('state:activate'), events.index('monitor-start'))
                self.assertIn('monitor-lifecycle-overlap', events)
                if mode in ('success', 'monitor-failed', 'identity-failed'):
                    self.assertIn('monitor-identity-overlap', events)
                    self.assertIn('identity-cleanup', events)
                if mode == 'success':
                    self.assertLess(events.index('monitor-finish'), events.index('stage:complete'))
                    self.assertLess(events.index('identity-finish'), events.index('stage:complete'))
                else:
                    self.assertNotIn('stage:complete', events)
                self.assertEqual(events[-1], 'cleanup:' + str(expected))

    def test_monitor_cancellation_joins_blocked_command_and_its_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ready = root / 'ready.fifo'
            blocked = root / 'blocked.fifo'
            cleanup = root / 'cleanup.log'
            os.mkfifo(ready)
            os.mkfifo(blocked)
            descriptor = os.open(ready, os.O_RDWR | os.O_NONBLOCK)
            command = root / 'gcloud'
            command.write_text('''#!/bin/bash
set -eu
trap 'wait; echo command-cleanup >> "$CLEANUP"; exit 143' TERM
bash -c '
trap "echo descendant-cleanup >> \"$CLEANUP\"; exit 143" TERM
exec 7<> "$BLOCKED"
echo descendant-ready > "$READY"
read -r stopped <&7
' &
exec 7<> "$BLOCKED"
echo command-ready > "$READY"
read -r stopped <&7
''')
            command.chmod(0o700)
            record = release_record()
            record['phase'] = 'lifecycle'
            save(root / 'release.json', record)
            save(root / 'baseline.json', {'ownerUserId': 'owner'})
            process = subprocess.Popen([sys.executable, '-m', 'infra.rollout_monitor', '--active',
                str(root / 'release.json'), str(root / 'monitor.json'), str(root / 'baseline.json'), '7'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                env={**os.environ, 'READY': str(ready), 'BLOCKED': str(blocked), 'CLEANUP': str(cleanup),
                     'PATH': directory + os.pathsep + os.environ['PATH']})
            try:
                events = b''
                while b'command-ready\n' not in events or b'descendant-ready\n' not in events:
                    self.assertTrue(select.select([descriptor], [], [], 10)[0], 'command readiness checkpoint missing')
                    events += os.read(descriptor, 4096)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 143, stdout + stderr)
                self.assertEqual(set(cleanup.read_text().splitlines()), {'command-cleanup', 'descendant-cleanup'})
                self.assertEqual(json.loads((root / 'monitor.json').read_text())['outcome'], 'observing')
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
                os.close(descriptor)

    def test_command_cleanup_kills_term_ignoring_descendant_after_leader_exit(self):
        for mode in ('stop', 'success'):
            with self.subTest(mode=mode):
                reader, writer = os.pipe()
                child = None
                spawn = subprocess.Popen
                descendant = (
                    'import os, signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                    f'os.write({writer}, b"ready"); signal.pause()')
                leader = (
                    'import os, subprocess, sys; '
                    f'subprocess.Popen([sys.executable, "-c", {descendant!r}], '
                    'stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, '
                    f'pass_fds=({writer},)); os.close({writer}); sys.stdin.read()')

                def owned_spawn(*args, **kwargs):
                    nonlocal child
                    child = spawn(*args, **kwargs, pass_fds=(writer,))
                    os.close(writer)
                    self.assertTrue(select.select([reader], [], [], 10)[0], 'descendant readiness missing')
                    self.assertEqual(os.read(reader, 5), b'ready')
                    return child

                try:
                    if mode == 'stop':
                        child = owned_spawn([sys.executable, '-c', leader], stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            start_new_session=True)
                        result = monitor.stop_command(child)
                    else:
                        with patch.object(monitor.subprocess, 'Popen', side_effect=owned_spawn):
                            result = monitor.monitor_command([sys.executable, '-c', leader])
                    self.assertIsNone(result.error)
                    self.assertIsNotNone(child.returncode, 'leader was not joined')
                    self.assertTrue(select.select([reader], [], [], 2)[0],
                                    'owned descendant survived leader exit')
                    self.assertEqual(os.read(reader, 1), b'', 'descendant still owns liveness pipe')
                finally:
                    if child is not None:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.communicate()
                    else:
                        os.close(writer)
                    os.close(reader)

    def test_command_spawn_checkpoint_cannot_lose_cancellation_or_child_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            cleanup = Path(directory) / 'cleanup'
            spawn = subprocess.Popen
            children = []
            handlers = {received: signal.getsignal(received) for received in monitor.MONITOR_SIGNALS}
            def interrupted_spawn(*args, **kwargs):
                child = spawn(*args, **kwargs)
                children.append(child)
                self.assertEqual(child.stdout.readline(), b'ready\n')
                os.kill(os.getpid(), signal.SIGTERM)
                return child
            try:
                with patch.object(monitor.subprocess, 'Popen', side_effect=interrupted_spawn):
                    with self.assertRaises(SystemExit) as stopped:
                        monitor.monitor_command(['bash', '-c',
                            "trap 'echo cleaned > \"$1\"; exit 143' TERM; echo ready; read -r blocked",
                            'command', str(cleanup)])
                self.assertEqual(stopped.exception.code, 143)
                self.assertEqual(cleanup.read_text(), 'cleaned\n')
                self.assertIsNotNone(children[0].returncode)
            finally:
                for received, handler in handlers.items():
                    signal.signal(received, handler)

    def test_command_timeouts_cleanup_escalates_and_platform_errors_are_typed(self):
        with patch.object(monitor.subprocess, 'Popen', side_effect=OSError):
            self.assertEqual(monitor.monitor_command(['missing']).error.kind, 'command')
        from unittest.mock import Mock, call
        child = Mock(pid=42, returncode=None)
        child.communicate.side_effect = [subprocess.TimeoutExpired('blocked', 120),
                                         subprocess.TimeoutExpired('blocked', 5), (b'', b'')]
        with patch.object(monitor.subprocess, 'Popen', return_value=child), \
                patch.object(monitor.os, 'killpg') as kill:
            self.assertEqual(monitor.monitor_command(['blocked']).error.kind, 'timeout')
        self.assertEqual(kill.call_args_list, [call(42, signal.SIGTERM), call(42, signal.SIGKILL)])

    def test_active_identity_requires_exact_owned_lock_and_authority(self):
        record = release_record()
        class FakeCloud:
            def __init__(self):
                self.lock = {'generation': '7', 'body': {
                    'releaseId': record['releaseId'], 'commit': record['commit']}}
                self.pointer = {'body': {'releaseId': record['releaseId'], 'generation': 42}}
            def object(self, _bucket, path):
                return Result(self.lock if path.endswith('release.lock') else self.pointer)
        cloud = FakeCloud()
        self.assertIsNone(monitor.release_identity(cloud, record, '7').error)
        for field, value in [('generation', '8'), ('releaseId', 'another-release'),
                             ('commit', 'c' * 40), ('missing', None)]:
            with self.subTest(field=field):
                changed = FakeCloud()
                if field == 'generation': changed.lock[field] = value
                elif field == 'missing': changed.lock = None
                else: changed.lock['body'][field] = value
                self.assertIsNotNone(monitor.release_identity(changed, record, '7').error)
        self.assertIsNotNone(monitor.release_identity(cloud, record).error)
        cloud.lock = None
        self.assertIsNone(monitor.release_identity(cloud, record).error)
        cloud.pointer['body']['releaseId'] = 'another-release'
        self.assertIsNotNone(monitor.release_identity(cloud, record).error)

    def test_live_record_reload_retains_fixture_changes_and_rejects_release_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'
            expected = release_record()
            expected['phase'] = 'lifecycle'
            current = copy.deepcopy(expected)
            current['fixtures'] = [{'kind': 'orb', 'id': 'fixture', 'outcome': 'created'}]
            save(path, current)
            self.assertEqual(monitor.live_record(path, expected).value['fixtures'], current['fixtures'])
            for field in ('releaseId', 'commit', 'project', 'region', 'artifacts', 'serving'):
                with self.subTest(field=field):
                    changed = copy.deepcopy(current)
                    changed[field] = 'other'
                    save(path, changed)
                    self.assertIsNotNone(monitor.live_record(path, expected).error)
            current['exitCode'] = 1
            save(path, current)
            self.assertIsNotNone(monitor.live_record(path, expected).error)

    def test_active_observation_reloads_fixture_record_at_each_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            record_path = Path(directory) / 'release.json'
            output = Path(directory) / 'monitor.json'
            record = release_record()
            record['phase'] = 'lifecycle'
            record['_monitorLockGeneration'] = '7'
            save(record_path, {key: value for key, value in record.items() if not key.startswith('_')})
            clock = iter([0, 0, 1080])
            seen = []
            def sample(_cloud, current, _start):
                seen.append(copy.deepcopy(current))
                return Result({'health': 'ok'})
            def checkpoint(_seconds):
                changed = {key: value for key, value in record.items() if not key.startswith('_')}
                changed['phase'] = 'identity'
                changed['fixtures'] = [{'kind': 'orb', 'id': 'fixture', 'outcome': 'created'}]
                save(record_path, changed)
            with patch.object(monitor, 'sample', side_effect=sample):
                result = monitor.observe(record, output, clock=lambda: next(clock),
                                         sleep=checkpoint, record_path=record_path)
            self.assertIsNone(result.error)
            self.assertEqual(seen[0]['fixtures'], [])
            self.assertEqual(seen[1]['fixtures'][0]['id'], 'fixture')
            self.assertEqual(seen[1]['_monitorLockGeneration'], '7')
            self.assertEqual(result.value['durationSeconds'], 1080)

    def test_only_known_project_fixture_not_found_is_tolerated(self):
        fixture = '00000000-0000-4000-8000-000000000001'
        real = '00000000-0000-4000-8000-000000000002'
        for known, response, okay in [
                (True, {'error': {'code': 'not_found'}}, True),
                (False, {'error': {'code': 'not_found'}}, False),
                (True, {'error': {'code': 'unavailable'}}, False)]:
            with self.subTest(known=known, response=response):
                fixtures = lambda: Result([{'kind': 'project', 'id': fixture, 'outcome': 'created'}] if known else [])
                with patch.object(monitor, 'api', side_effect=[
                        Result({'items': [{'id': fixture}, {'id': real}]}), Result(response),
                        Result({'items': [{'harness': 'pi', 'state': 'running', 'centralAgent': True}]})]):
                    result = monitor.fleet_inventory(object(), fixtures=fixtures)
                self.assertEqual(result.error is None, okay)
        with patch.object(monitor, 'api', side_effect=[
                Result({'items': [{'id': fixture}]}),
                Result({'items': [{'harness': 'pi', 'state': 'running', 'centralAgent': False}]})]):
            self.assertIsNotNone(monitor.fleet_inventory(object(), fixtures=lambda: Result([
                {'kind': 'project', 'id': fixture, 'outcome': 'created'}])).error)

    def test_final_verification_requires_completed_record_full_window_and_clean_fixtures(self):
        record = release_record()
        record.update(phase='complete', outcome='validated', exitCode=0,
                      finishedAt='2026-10-16T12:18:00Z', gates=dict.fromkeys(
                          ('preflight', 'checks', 'build', 'plan', 'schema', 'apply',
                           'repair', 'retire', 'activate', 'lifecycle', 'identity', 'complete'), 'passed'))
        evidence = {'releaseId': record['releaseId'], 'commit': record['commit'],
                    'generation': 42, 'durationSeconds': 1080, 'metricLagSeconds': 180,
                    'outcome': 'observed', 'startedAt': '2026-10-16T12:00:00Z',
                    'finishedAt': '2026-10-16T12:18:00Z', 'samples': [
                        {'at': '2026-10-16T12:00:00Z', 'outcome': 'observed'},
                        {'at': '2026-10-16T12:18:00Z', 'outcome': 'observed'}]}
        with patch.object(monitor, 'sample', return_value=Result({'health': 'ok'})) as sample:
            self.assertIsNone(monitor.verify(record, evidence, object()).error)
            self.assertNotIn('_monitorLockGeneration', sample.call_args.args[1])
            for validation_only in (False, True):
                completed = copy.deepcopy(record)
                if validation_only:
                    completed['validatesRelease'] = 'original-release'
                    for gate in ('checks', 'build', 'plan', 'schema', 'apply'):
                        del completed['gates'][gate]
                self.assertTrue(validate_record(completed))
                self.assertIsNone(monitor.verify(completed, evidence, object()).error)
                for gate in completed['gates']:
                    with self.subTest(validation_only=validation_only, missing_gate=gate):
                        incomplete = copy.deepcopy(completed)
                        del incomplete['gates'][gate]
                        self.assertTrue(validate_record(incomplete))
                        self.assertIsNotNone(monitor.verify(incomplete, evidence, object()).error)
                for state in ('running', 'failed'):
                    with self.subTest(validation_only=validation_only, maintenance=state):
                        incomplete = copy.deepcopy(completed)
                        incomplete['gates']['maintenance'] = state
                        self.assertIsNotNone(monitor.verify(incomplete, evidence, object()).error)
                completed['gates']['maintenance'] = 'passed'
                self.assertIsNone(monitor.verify(completed, evidence, object()).error)
            for field, value in [('durationSeconds', 1079), ('outcome', 'incomplete'),
                                 ('releaseId', 'other'), ('commit', 'c' * 40), ('generation', 43),
                                 ('startedAt', None), ('startedAt', 'invalid'), ('finishedAt', None),
                                 ('finishedAt', '2026-10-16T12:17:59Z'), ('samples', []), ('samples', None),
                                 ('samples', [{'at': '2026-10-16T12:18:00Z', 'outcome': 'observed'}]),
                                 ('samples', [{'at': '2026-10-16T12:00:00Z', 'outcome': 'observed'},
                                              {'at': '2026-10-16T12:14:59Z', 'outcome': 'observed'}]),
                                 ('samples', [{'at': None, 'outcome': 'observed'},
                                              {'at': '2026-10-16T12:18:00Z', 'outcome': 'observed'}]),
                                 ('samples', [{'at': '2026-10-16T12:00:00Z', 'outcome': 'unavailable'},
                                              {'at': '2026-10-16T12:18:00Z', 'outcome': 'observed'}])]:
                with self.subTest(field=field):
                    self.assertIsNotNone(monitor.verify(record, {**evidence, field: value}, object()).error)
            for field, value in [('outcome', 'applied-but-unvalidated'), ('exitCode', 1),
                                 ('gates', {'complete': 'failed'}), ('artifacts', None), ('serving', None),
                                 ('fixtures', [{'kind': 'orb', 'id': 'fixture', 'outcome': 'retained'}])]:
                with self.subTest(field=field):
                    self.assertIsNotNone(monitor.verify({**record, field: value}, evidence, object()).error)
        with patch.object(monitor, 'sample', return_value=fail('conflict', 'release lock present after completion')):
            self.assertIsNotNone(monitor.verify(record, evidence, object()).error)
        for observed in ({'logs': {'errors': 1}}, {'logs': {'http5xx': 1}},
                         {'logs': {'http429': 1}}, {'lifecycle': {'history_integrity': 1}}):
            with self.subTest(observed=observed), patch.object(monitor, 'sample', return_value=Result(observed)):
                self.assertIsNotNone(monitor.verify(record, evidence, object()).error)

    def test_projection_never_retains_payloads_or_freeform_errors(self):
        rows = [{'severity': 'ERROR', 'textPayload': 'secret prompt',
                 'jsonPayload': {'code': 'legacy_backend', 'prompt': 'secret'},
                 'httpRequest': {'status': 503, 'requestUrl': 'secret'}}]
        self.assertEqual(monitor.log_counts(rows),
                         {'errors': 1, 'http429': 0, 'http5xx': 1, 'legacyBackend': 1})
        self.assertNotIn('secret', json.dumps(monitor.log_counts(rows)))

    def test_window_cannot_finish_early_and_first_fault_is_not_erased(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 0, 60, 120, 1080])
            samples = iter([Result({'health': 'ok'}), fail('http', 'health unavailable'),
                            Result({'health': 'ok'}), Result({'health': 'ok'})])
            with patch.object(monitor, 'sample', side_effect=lambda *_: next(samples)):
                result = monitor.observe({}, output, clock=lambda: next(clock), sleep=lambda _: None)
            self.assertIsNotNone(result.error)
            evidence = json.loads(output.read_text())
            self.assertEqual(evidence['durationSeconds'], 1080)
            self.assertEqual(evidence['metricLagSeconds'], 180)
            self.assertEqual(evidence['samples'][1]['outcome'], 'unavailable')
            self.assertEqual(evidence['samples'][1]['category'], 'http')
            self.assertEqual(evidence['samples'][1]['message'], 'health unavailable')
            self.assertIn('at', evidence['samples'][1])

    def test_lifecycle_classification_separates_expected_refusal(self):
        rows = [{'textPayload': 'lifecycle: orb=secret central-agent-start-rejected code=legacy_backend message=secret'},
                {'textPayload': 'lifecycle: orb=secret central-agent-start-rejected code=history_integrity message=secret'},
                {'textPayload': 'lifecycle: orb=secret drain-integrity reason=secret'}]
        counts = monitor.lifecycle_counts(rows)
        self.assertEqual(counts, {'legacy_backend': 1, 'history_integrity': 1, 'drain-integrity': 1})
        self.assertNotIn('secret', json.dumps(counts))

    def test_readonly_queries_paginate_and_missing_metrics_are_incomplete(self):
        class FakeCloud:
            def __init__(self):
                self.calls = []
            def http(self, method, url, body=None):
                self.calls.append((method, url, body))
                return Result({'timeSeries': []})
        cloud = FakeCloud()
        self.assertIsNotNone(monitor.metric_coverage(cloud, 'project', 'sql', 'cpu', 'start', 'end').error)
        self.assertTrue(all(call[0] == 'GET' for call in cloud.calls))
        class Pages(FakeCloud):
            def http(self, method, url, body=None):
                self.calls.append((method, url, body))
                return Result({'timeSeries': [{'points': [{'interval': {'endTime': 'stamp'}, 'value': {'doubleValue': 1}}]}],
                               **({'nextPageToken': 'next'} if len(self.calls) == 1 else {})})
        cloud = Pages()
        self.assertEqual(monitor.metric_coverage(cloud, 'project', 'sql', 'cpu', 'start', 'end').value['series'], 2)
        self.assertIn('pageToken=next', cloud.calls[1][1])

    def test_first_request_failure_keeps_initial_partial_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            def stopped(*_):
                self.assertEqual(json.loads(output.read_text())['outcome'], 'observing')
                raise RuntimeError('simulated runner termination')
            with patch.object(monitor, 'sample', side_effect=stopped):
                with self.assertRaises(RuntimeError):
                    monitor.observe({}, output)

    def test_info_legacy_refusals_cannot_hide_an_unrelated_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 1080])
            with patch.object(monitor, 'sample', return_value=Result({
                    'logs': {'errors': 1}, 'lifecycle': {'legacy_backend': 2}})):
                self.assertIsNotNone(monitor.observe({}, output, clock=lambda: next(clock)).error)
            self.assertEqual(json.loads(output.read_text())['outcome'], 'regression')

    def test_generic_error_is_a_regression_not_a_healthy_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 1080])
            with patch.object(monitor, 'sample', return_value=Result({'logs': {'errors': 1}})):
                self.assertIsNotNone(monitor.observe({}, output, clock=lambda: next(clock)).error)
            self.assertEqual(json.loads(output.read_text())['outcome'], 'regression')

    def test_ingress_429_is_retained_even_when_application_probes_succeed(self):
        self.assertEqual(monitor.log_counts([{'httpRequest': {'status': 429}}])['http429'], 1)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 1080])
            with patch.object(monitor, 'sample', return_value=Result({
                    'health': 'ok', 'logs': {'http429': 1}})):
                self.assertIsNotNone(monitor.observe({}, output, clock=lambda: next(clock)).error)
            self.assertEqual(json.loads(output.read_text())['outcome'], 'regression')

    def test_owner_inventory_cannot_succeed_with_an_unexpected_empty_fleet(self):
        with patch.object(monitor, 'api', return_value=Result({'items': []})):
            self.assertIsNotNone(monitor.fleet_inventory(object(), False).error)

    def test_composed_readonly_sample_has_exact_identity_and_numeric_metrics(self):
        record = {'project': 'project', 'region': 'region', 'releaseId': 'release',
                  'artifacts': {'control_plane_image': 'image', 'deploy_generation': 1},
                  'serving': [{'service': 'pi-orb-issuer', 'revision': 'revision', 'image': 'image', 'generation': 1}]}
        service = {'status': {'latestReadyRevisionName': 'revision', 'traffic': [
            {'revisionName': 'revision', 'percent': 100}]}, 'spec': {'template': {'spec': {
            'containers': [{'image': 'image', 'env': [
                {'name': 'PI_ORB_AGENT_BACKEND', 'value': 'central-durable'},
                {'name': 'PI_ORB_HOST_SPEC_GENERATION', 'value': '1'},
                {'name': 'PI_ORB_APP_ORIGIN', 'value': 'https://application.example'}]}]}}}}
        class FakeCloud:
            def __init__(self):
                self.calls = []
            def json(self, args):
                self.calls.append(args)
                return Result(service if args[0] == 'run' else {'state': 'RUNNABLE'} if args[0] == 'sql' else [])
            def object(self, _bucket, path):
                return Result(None if path.endswith('release.lock') else {
                    'body': {'releaseId': 'release', 'generation': 1}})
            def http(self, method, url, body=None):
                self.calls.append((method, url))
                return Result({'timeSeries': [{'points': [{'interval': {'endTime': 'stamp'},
                    'value': {'doubleValue': 1}}]}]})
        cloud = FakeCloud()
        with patch.object(monitor.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"status":"ok"}')), \
                patch.object(monitor, 'api', side_effect=[
                    Result({'items': [{'id': '00000000-0000-4000-8000-000000000001'}]}),
                    Result({'items': [{'harness': 'pi', 'state': 'running', 'centralAgent': True},
                                      {'harness': 'claude', 'state': 'archived'}]})]):
            result = monitor.sample(cloud, record, 'start')
        self.assertIsNone(result.error)
        self.assertEqual(result.value['metrics']['sqlCpu']['maximum'], 1)
        self.assertEqual(result.value['metrics']['runCpu']['maximum'], 1)
        queries = str(cloud.calls)
        self.assertIn('resource.labels.revision_name', queries)
        self.assertIn('resource.labels.location', queries)
        self.assertIn('httpRequest.status=429', queries)
        self.assertNotIn('delete', queries)
        record['serving'][0]['revision'] = 'another-revision'
        self.assertEqual(monitor.sample(cloud, record, 'start').error.message, 'serving revision changed')

    def test_effective_setting_rejects_wrong_backend_and_image(self):
        service = {'status': {'latestReadyRevisionName': 'revision'},
                   'spec': {'template': {'spec': {'containers': [{'image': 'image', 'env': [
                       {'name': 'PI_ORB_AGENT_BACKEND', 'value': 'central-durable'}]}]}}}}
        self.assertIsNone(monitor.placement(service, 'image').error)
        self.assertIsNotNone(monitor.placement(service, 'wrong').error)
        service['spec']['template']['spec']['containers'][0]['env'][0]['value'] = 'host-pi'
        self.assertIsNotNone(monitor.placement(service, 'image').error)


if __name__ == '__main__':
    unittest.main()
