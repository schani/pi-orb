import io
import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from infra.release_state import Result, fail
from infra import rollout_monitor as monitor


class MonitorTest(unittest.TestCase):
    def test_workflow_monitor_survives_the_deploying_orb(self):
        workflow = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('python3 -m infra.rollout_monitor', workflow)
        self.assertIn('rollout-monitor-${{ github.run_id }}-${{ github.run_attempt }}', workflow)
        self.assertIn('if: always()', workflow.split('- name: Upload rollout monitor')[1])

    def test_projection_never_retains_payloads_or_freeform_errors(self):
        rows = [{'severity': 'ERROR', 'textPayload': 'secret prompt',
                 'jsonPayload': {'prompt': 'secret'},
                 'httpRequest': {'status': 503, 'requestUrl': 'secret'}}]
        self.assertEqual(monitor.log_counts(rows),
                         {'errors': 1, 'errorsRaw': 1, 'http429': 0, 'http5xx': 1,
                          'http429Recovered': 0, 'http429Unrecovered': 0})
        self.assertNotIn('secret', json.dumps(monitor.log_counts(rows)))

    def test_window_cannot_finish_early_and_first_fault_is_not_erased(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 0, 0, 60, 60, 120, 120, 1090, 1090])
            samples = iter([Result({'health': 'ok'}), fail('http', 'health unavailable'),
                            Result({'health': 'ok'}), Result({'health': 'ok'})])
            with patch.object(monitor, 'sample', side_effect=lambda *_: next(samples)):
                result = monitor.observe({}, output, clock=lambda: next(clock), sleep=lambda _: None)
            self.assertIsNotNone(result.error)
            evidence = json.loads(output.read_text())
            self.assertEqual(evidence['durationSeconds'], 1090)
            self.assertEqual(evidence['metricLagSeconds'], 180)
            self.assertEqual(evidence['samples'][1]['outcome'], 'unavailable')
            self.assertEqual(evidence['samples'][1]['category'], 'http')
            self.assertEqual(evidence['samples'][1]['message'], 'health unavailable')
            self.assertIn('at', evidence['samples'][1])

    def test_lifecycle_classification_retains_integrity_failures(self):
        rows = [{'textPayload': 'lifecycle: orb=secret central-agent-start-rejected code=history_integrity message=secret'},
                {'textPayload': 'lifecycle: orb=secret drain-integrity reason=secret'}]
        counts = monitor.lifecycle_counts(rows)
        self.assertEqual(counts, {'history_integrity': 1, 'drain-integrity': 1})
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

    def test_generic_error_is_a_regression_not_a_healthy_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 1090, 1090])
            with patch.object(monitor, 'sample', return_value=Result({'logs': {'errors': 1}})):
                self.assertIsNotNone(monitor.observe({}, output, clock=lambda: next(clock)).error)
            self.assertEqual(json.loads(output.read_text())['outcome'], 'regression')

    def test_ingress_429_is_retained_even_when_application_probes_succeed(self):
        self.assertEqual(monitor.log_counts([{'httpRequest': {'status': 429}}])['http429'], 1)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 1090, 1090])
            with patch.object(monitor, 'sample', return_value=Result({
                    'health': 'ok', 'logs': {'http429': 1, 'http429Unrecovered': 1}})):
                self.assertIsNotNone(monitor.observe({}, output, clock=lambda: next(clock)).error)
            self.assertEqual(json.loads(output.read_text())['outcome'], 'regression')

    @staticmethod
    def request(status, seconds=0, trace='a' * 32, **extra):
        return {'logName': 'projects/project/logs/run.googleapis.com%2Frequests',
                'trace': 'projects/project/traces/' + trace,
                'resource': {'type': 'cloud_run_revision', 'labels': {
                    'service_name': 'pi-orb-issuer', 'location': 'region', 'revision_name': 'revision'}},
                'timestamp': (datetime(2026, 11, 6, tzinfo=timezone.utc) +
                              timedelta(seconds=seconds)).isoformat(),
                'httpRequest': {'status': status, 'requestMethod': 'POST',
                                'requestUrl': 'https://issuer.example/runtime/v1/id-token'},
                **extra}

    def test_only_later_same_invocation_http_success_recovers_throttling(self):
        throttled = self.request(429)
        recovered = self.request(200, 2)
        other = self.request(429, 1, trace='b' * 32)
        for successes, expected in [([], 0), ([recovered], 1),
                                     ([self.request(200, 2, trace='c' * 32)], 0),
                                     ([self.request(200, 11)], 0),
                                     ([self.request(200, -1)], 0)]:
            with self.subTest(successes=successes):
                counts = monitor.log_counts([other, throttled], successes, 'project', 'region', 'revision')
                self.assertEqual(counts['http429'], 2)
                self.assertEqual(counts['http429Recovered'], expected)
                self.assertEqual(counts['http429Unrecovered'], 2 - expected)
        # Multiple throttles, reverse log delivery, and an unrelated error.
        counts = monitor.log_counts([self.request(429, 1), throttled,
                                     {'severity': 'ERROR'}], [recovered], 'project', 'region', 'revision')
        self.assertEqual(counts['http429Recovered'], 2)
        self.assertEqual(counts['errors'], 1)
        expired = monitor.log_counts([throttled, self.request(429, 9)],
                                     [self.request(200, 11)], 'project', 'region', 'revision')
        self.assertEqual(expired['http429Recovered'], 0)
        self.assertNotIn('issuer.example', json.dumps(counts))
        self.assertNotIn('a' * 32, json.dumps(counts))

    def test_malformed_or_non_identity_logs_cannot_claim_recovery(self):
        throttled, success = self.request(429), self.request(200, 2)
        malformed = [
            {'trace': None}, {'trace': 'projects/other/traces/' + 'a' * 32},
            {'trace': 'projects/project/traces/' + '0' * 32},
            {'timestamp': 'unknown'}, {'resource': {}},
            {'resource': {'type': 'cloud_run_revision', 'labels': {
                'service_name': 'pi-orb-issuer', 'location': 'other', 'revision_name': 'revision'}}},
            {'timestamp': '2026-11-06'},
            {'trace': 'malformed'},
            {'logName': 'projects/project/logs/run.googleapis.com%2Fstdout'},
            {'httpRequest': {'status': 200, 'requestMethod': 'GET',
                             'requestUrl': 'https://issuer.example/runtime/v1/id-token'}},
            {'httpRequest': {'status': 200, 'requestMethod': 'POST',
                             'requestUrl': 'https://issuer.example/other'}},
            {'httpRequest': {'status': 200, 'requestMethod': 'POST',
                             'requestUrl': 'https://issuer.example/runtime/v1/id-token?secret=1'}},
        ]
        for fields in malformed:
            with self.subTest(fields=fields):
                self.assertEqual(monitor.log_counts([throttled], [{**success, **fields}],
                                                   'project', 'region', 'revision')['http429Recovered'], 0)
        # A recovered native HTTP error is not an independent generic ERROR.
        counts = monitor.log_counts([{**throttled, 'severity': 'ERROR'}], [success], 'project', 'region', 'revision')
        self.assertEqual(counts['errors'], 0)
        self.assertEqual(counts['errorsRaw'], 1)
        pending = monitor.log_counts([{**throttled, 'severity': 'ERROR'}], [],
                                     'project', 'region', 'revision')
        self.assertEqual(pending['errors'], 0)
        self.assertEqual(pending['errorsRaw'], 1)
        self.assertEqual(pending['http429Unrecovered'], 1)

    def test_pending_throttle_does_not_latch_but_other_first_faults_do(self):
        for first in ({'http429': 1, 'http429Unrecovered': 1},
                      {'http429': 1, 'http429Unrecovered': 1, 'http5xx': 1},
                      {'http429': 1, 'http429Unrecovered': 1, 'errors': 1}):
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'monitor.json'
                clock = iter([0, 0, 0, 1090, 1090])
                samples = iter([Result({'logs': first}), Result({'logs': {
                    'http429': 1, 'http429Recovered': 1, 'http429Unrecovered': 0}})])
                with patch.object(monitor, 'sample', side_effect=lambda *_: next(samples)):
                    result = monitor.observe({}, output, clock=lambda: next(clock), sleep=lambda _: None)
                self.assertEqual(result.error is None, not (first.get('http5xx') or first.get('errors')))
                evidence = json.loads(output.read_text())
                self.assertEqual(evidence['samples'][0]['logs']['http429Unrecovered'], 1)

    def test_final_read_waits_for_retry_budget_and_its_ingestion_lag(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            elapsed = [1080]
            calls = []
            def capture(*_):
                calls.append(elapsed[0])
                if len(calls) == 2:
                    self.assertEqual(json.loads(output.read_text())['outcome'], 'observing')
                return Result({'logs': {'http429': 1, 'http429Recovered': int(elapsed[0] >= 1090),
                                        'http429Unrecovered': int(elapsed[0] < 1090)}})
            def sleep(_):
                elapsed[0] = 1090
            times = iter([0])
            def clock():
                return next(times, elapsed[0])
            with patch.object(monitor, 'sample', side_effect=capture):
                result = monitor.observe({}, output, clock=clock, sleep=sleep)
            self.assertIsNone(result.error)
            self.assertEqual(calls, [1080, 1090])
            self.assertEqual(json.loads(output.read_text())['durationSeconds'], 1090)

    def test_sample_crossing_deadline_needs_a_fresh_final_log_read(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            elapsed, calls = [1070], []
            def capture(*_):
                calls.append(elapsed[0])
                elapsed[0] = 1091
                return Result({'logs': {'http429': 1, 'http429Unrecovered': int(len(calls) == 1)}})
            times = iter([0])
            with patch.object(monitor, 'sample', side_effect=capture):
                result = monitor.observe({}, output, clock=lambda: next(times, elapsed[0]),
                                         sleep=lambda _: None)
            self.assertIsNone(result.error)
            self.assertEqual(calls, [1070, 1091])

    def test_a_disappearing_throttle_inventory_is_incomplete_not_recovered(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 0, 0, 1090, 1090])
            samples = iter([Result({'logs': {'http429': 1, 'http429Unrecovered': 1}}),
                            Result({'logs': {'http429': 0, 'http429Unrecovered': 0}})])
            with patch.object(monitor, 'sample', side_effect=lambda *_: next(samples)):
                result = monitor.observe({}, output, clock=lambda: next(clock), sleep=lambda _: None)
            self.assertIsNotNone(result.error)
            self.assertEqual(json.loads(output.read_text())['outcome'], 'incomplete')

    def test_fixed_failure_window_allows_tail_retry_during_ingestion(self):
        class Logs:
            def __init__(self, owner):
                self.calls = []
                self.owner = owner
            def json(self, args):
                self.calls.append(args)
                return Result([self.owner.request(429, 900)] if len(self.calls) == 1 else
                              [self.owner.request(200, 910)])
        cloud = Logs(self)
        result = monitor.rollout_logs(cloud, 'project', 'region', 'revision',
                                      '2026-11-06T00:00:00Z')
        self.assertIsNone(result.error)
        self.assertEqual(result.value['counts']['http429Recovered'], 1)
        self.assertIn('timestamp<="2026-11-06T00:15:00Z"', cloud.calls[0][2])
        self.assertIn('timestamp<="2026-11-06T00:15:10Z"', cloud.calls[1][2])
        self.assertIn('httpRequest.status=200', cloud.calls[1][2])
        self.assertIn('projects/project/traces/' + 'a' * 32, cloud.calls[1][2])

    def test_ingestion_tail_keeps_independent_errors_5xx_and_lifecycle_logs(self):
        class Logs:
            def json(self, args):
                self.query = args[2]
                return Result([{'severity': 'ERROR', 'timestamp': '2026-11-06T00:18:10Z'},
                               {'httpRequest': {'status': 503}, 'timestamp': '2026-11-06T00:18:10Z'},
                               {'textPayload': 'lifecycle: drain-integrity',
                                'timestamp': '2026-11-06T00:17:00Z'}])
        cloud = Logs()
        result = monitor.rollout_logs(cloud, 'project', 'region', 'revision',
                                      '2026-11-06T00:00:00Z')
        self.assertIn('((httpRequest.status=429 AND timestamp<="2026-11-06T00:15:00Z") OR ',
                      cloud.query)
        # Logging NOT matches absent status fields too; != would drop application logs.
        self.assertIn('((NOT httpRequest.status=429) AND (severity>=ERROR OR ', cloud.query)
        self.assertEqual(result.value['counts']['errors'], 1)
        self.assertEqual(result.value['counts']['http5xx'], 1)
        self.assertEqual(result.value['lifecycle'], {'drain-integrity': 1})

    def test_log_query_errors_truncation_and_bad_envelopes_are_incomplete(self):
        for response in (fail('http', 'logs unavailable'), Result([{}] * 1000),
                         Result({}), Result([{'httpRequest': None}])):
            for query in (1, 2):
                class Logs:
                    def __init__(self, owner):
                        self.count = 0
                        self.owner = owner
                    def json(self, _args):
                        self.count += 1
                        return response if self.count == query else Result([self.owner.request(429)])
                with self.subTest(response=response, query=query):
                    result = monitor.rollout_logs(Logs(self), 'project', 'region', 'revision',
                                                  '2026-11-06T00:00:00Z')
                    self.assertIsNotNone(result.error)

    def test_owner_inventory_cannot_succeed_with_an_unexpected_empty_fleet(self):
        with patch.object(monitor, 'api', return_value=Result({'items': []})):
            self.assertIsNotNone(monitor.fleet_inventory(object()).error)

    def test_owner_inventory_requires_central_pi_and_native_claude(self):
        for harness in ('pi', 'claude'):
            for central in (False, True):
                with self.subTest(harness=harness, central=central), patch.object(
                        monitor, 'api', side_effect=[
                            Result({'items': [{'id': '00000000-0000-4000-8000-000000000001'}]}),
                            Result({'items': [{'harness': harness, 'state': 'running',
                                               'centralAgent': central}]})]):
                    result = monitor.fleet_inventory(object())
                if central == (harness == 'pi'):
                    self.assertEqual(result.value['counts'], {harness + ':running': 1})
                else:
                    self.assertEqual(result.error.kind, 'conflict')

    def test_composed_readonly_sample_has_exact_identity_and_numeric_metrics(self):
        record = {'project': 'project', 'region': 'region', 'releaseId': 'release',
                  'artifacts': {'control_plane_image': 'image', 'deploy_generation': 1}}
        service = {'status': {'latestReadyRevisionName': 'revision', 'traffic': [
            {'revisionName': 'revision', 'percent': 100}]}, 'spec': {'template': {'spec': {
            'containers': [{'image': 'image', 'env': [
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
            result = monitor.sample(cloud, record, '2026-11-06T00:00:00Z')
        self.assertIsNone(result.error)
        self.assertEqual(result.value['metrics']['sqlCpu']['maximum'], 1)
        self.assertEqual(result.value['metrics']['runCpu']['maximum'], 1)
        queries = str(cloud.calls)
        self.assertIn('resource.labels.revision_name', queries)
        self.assertIn('resource.labels.location', queries)
        self.assertIn('httpRequest.status=429', queries)
        self.assertNotIn('delete', queries)

    def test_effective_setting_rejects_wrong_image(self):
        service = {'status': {'latestReadyRevisionName': 'revision'},
                   'spec': {'template': {'spec': {'containers': [{'image': 'image', 'env': [
                       {'name': 'PI_ORB_HOST_SPEC_GENERATION', 'value': '1'}]}]}}}}
        self.assertEqual(monitor.placement(service, 'image').value,
                         {'revision': 'revision', 'generation': '1'})
        self.assertIsNotNone(monitor.placement(service, 'wrong').error)


class MonitorReadRetryTest(unittest.TestCase):
    def test_recovered_reads_observe_but_exhaustion_stays_incomplete(self):
        import subprocess
        from infra import smoke_http
        for exhausted in (False, True):
            with self.subTest(exhausted=exhausted), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'monitor.json'
                elapsed, calls = [0.0], []
                def sleep(seconds):
                    elapsed[0] += seconds
                def run(args, **kwargs):
                    if args[0] == 'gcloud':
                        return subprocess.CompletedProcess(args, 0, b'secret-token', b'')
                    calls.append(args)
                    failed = len(calls) <= (5 if exhausted else 1)
                    Path(args[args.index('--output') + 1]).write_bytes(b'{}' if failed else
                        b'{"timeSeries":[{"points":[{"interval":{"endTime":"stamp"},"value":{"doubleValue":1}}]}]}')
                    return subprocess.CompletedProcess(args, 0, b'503' if failed else b'200', b'')
                def capture(cloud, *_):
                    self.assertTrue(output.exists())
                    return monitor.metric_coverage(cloud, 'project', 'sql', 'cpu', 'start', 'end')
                with patch.object(monitor, 'sample', side_effect=capture), \
                        patch.object(smoke_http.subprocess, 'run', side_effect=run), \
                        patch.object(smoke_http.time, 'monotonic', side_effect=lambda: elapsed[0]), \
                        patch.object(smoke_http.time, 'sleep', side_effect=sleep), patch('sys.stderr', io.StringIO()) as log:
                    result = monitor.observe({}, output, clock=lambda: elapsed[0], sleep=sleep)
                evidence = json.loads(output.read_text())
                self.assertEqual(result.error is not None, exhausted)
                self.assertEqual(evidence['outcome'], 'incomplete' if exhausted else 'observed')
                self.assertEqual(evidence['samples'][0]['outcome'], 'unavailable' if exhausted else 'observed')
                self.assertEqual(evidence['samples'][-1]['outcome'], 'observed')
                self.assertGreaterEqual(evidence['durationSeconds'], 1090)
                self.assertIn('operation=monitor-read', log.getvalue())
                self.assertNotIn('secret', log.getvalue())

    def test_default_reads_and_all_mutations_stay_single_shot(self):
        import urllib.error
        for retry_reads, methods in ((False, ('GET', 'POST', 'PUT', 'DELETE')),
                                     (True, ('POST', 'PUT', 'DELETE'))):
            cloud = monitor.Cloud(retry_reads=retry_reads)
            for method in methods:
                with self.subTest(retry_reads=retry_reads, method=method), \
                        patch.object(cloud, 'run', return_value=Result(b'secret-token')) as token, \
                        patch.object(cloud, 'request', side_effect=urllib.error.HTTPError('https://example.test', 503, 'secret', {}, None)) as request:
                    self.assertIsNotNone(cloud.http(method, 'https://example.test').error)
                    self.assertEqual(request.call_count, 1)
                    token.assert_called_once_with(['gcloud', 'auth', 'print-access-token'])


if __name__ == '__main__':
    unittest.main()
