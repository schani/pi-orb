import io
import json
import tempfile
import unittest
from pathlib import Path
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
                 'jsonPayload': {'code': 'legacy_backend', 'prompt': 'secret'},
                 'httpRequest': {'status': 503, 'requestUrl': 'secret'}}]
        self.assertEqual(monitor.log_counts(rows),
                         {'errors': 1, 'http5xx': 1, 'legacyBackend': 1})
        self.assertNotIn('secret', json.dumps(monitor.log_counts(rows)))

    def test_window_cannot_finish_early_and_first_fault_is_not_erased(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'monitor.json'
            clock = iter([0, 0, 60, 120, 1080])
            samples = iter([Result({'health': 'ok'}), fail('http', 'secret'),
                            Result({'health': 'ok'}), Result({'health': 'ok'})])
            with patch.object(monitor, 'sample', side_effect=lambda *_: next(samples)):
                result = monitor.observe({}, output, clock=lambda: next(clock), sleep=lambda _: None)
            self.assertIsNotNone(result.error)
            evidence = json.loads(output.read_text())
            self.assertEqual(evidence['durationSeconds'], 1080)
            self.assertEqual(evidence['metricLagSeconds'], 180)
            self.assertEqual(evidence['samples'][1]['outcome'], 'unavailable')
            self.assertEqual(evidence['samples'][1]['category'], 'http')
            self.assertIn('at', evidence['samples'][1])
            self.assertNotIn('secret', output.read_text())

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

    def test_owner_inventory_cannot_succeed_with_an_unexpected_empty_fleet(self):
        with patch.object(monitor, 'api', return_value=Result({'items': []})):
            self.assertIsNotNone(monitor.fleet_inventory(object(), False).error)

    def test_composed_readonly_sample_has_exact_identity_and_numeric_metrics(self):
        record = {'project': 'project', 'region': 'region', 'releaseId': 'release',
                  'artifacts': {'control_plane_image': 'image', 'deploy_generation': 1}}
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
        queries = str(cloud.calls)
        self.assertIn('resource.labels.revision_name', queries)
        self.assertIn('resource.labels.location', queries)
        self.assertNotIn('delete', queries)

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
