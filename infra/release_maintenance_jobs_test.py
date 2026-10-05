import unittest
import json
from unittest.mock import patch
from infra.release_consolidation import run_phase
from infra.release_state_test import record
from infra.release_state import Result, fail
from infra.release_maintenance_jobs import execute, wait_created


class JobsTest(unittest.TestCase):
    def test_creation_wait_is_bounded_and_checks_exact_job(self):
        clock = [0]
        class Cloud:
            def http(self, *args): return Result({'done': False})
        result = wait_created(Cloud(), 'projects/p/locations/r/jobs/pi-orb-maint-owned', {'name': 'projects/p/locations/r/operations/o'}, lambda value: Result(), monotonic=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds), limit=30)
        self.assertEqual(result.error.kind, 'timeout')
        class WrongCloud:
            def http(self, *args): return Result({'done': True, 'response': {'name': 'another-job'}})
        self.assertIsNotNone(wait_created(WrongCloud(), 'projects/p/locations/r/jobs/pi-orb-maint-owned', {'name': 'projects/p/locations/r/operations/o'}, lambda value: Result()).error)

    def test_phase_copies_exact_private_bytes_before_terminal_job_delete(self):
        for failure_at in (None, 'copy', 'schema', 'existing'):
            calls = []
            value = record()
            job_id = f"pi-orb-maint-before-{value['releaseId']}"[:63]
            envelope = {'schemaVersion': 1, 'releaseId': value['releaseId'], 'sourceSha': value['commit'], 'executionId': job_id, 'phase': 'before', 'mode': 'inventory', 'outcome': 'sealed', 'counts': {'orbs': 0}, 'snapshot': {'releaseId': value['releaseId'], 'phase': 'before', 'orbs': [], 'projects': [], 'resumeCandidates': []}}
            if failure_at == 'schema': envelope['privatePayload'] = 'never-print'
            raw = (json.dumps(envelope, indent=2) + '\n').encode()
            class Cloud:
                def http(self, method, url, body=None):
                    calls.append((method, url))
                    if '/storage/v1/' in url: return Result({'items': []})
                    if '/executions?' in url: return Result({'executions': []})
                    return Result({'name': 'existing'}) if failure_at == 'existing' else Result(None)
                def json(self, args):
                    calls.append(tuple(args))
                    return Result({'generation': '42'})
                def bytes(self, *args): return Result(raw)
                def copy_bytes(self, bucket, key, body):
                    calls.append(('copy', key))
                    self_test.assertEqual(body, raw)
                    return fail('http', 'injected') if failure_at == 'copy' else Result({'generation': '99'})
            self_test = self
            config = {'env': {'PI_ORB_HOSTING_BUCKET': 'private-data'}, 'secrets': {}, 'serviceAccount': 'cp@test', 'vpcAccess': {}}
            with patch('infra.release_consolidation.wait_created', return_value=Result()), patch('infra.release_consolidation.execute', return_value=Result({'state': 'terminal'})):
                result = run_phase(Cloud(), value, config, 'before', lambda receipt: Result())
            self.assertEqual(result.error is None, failure_at is None)
            deleted = [i for i, call in enumerate(calls) if call[:3] == ('run', 'jobs', 'delete')]
            self.assertEqual(bool(deleted), failure_at is None)
            if deleted: self.assertLess(next(i for i, call in enumerate(calls) if call[0] == 'copy'), deleted[0])

    def test_run_intent_durable_before_request(self):
        calls = []
        class Cloud:
            def http(self, *args): calls.append(args); return Result()
        self.assertIsNotNone(execute(Cloud(), 'projects/p/locations/r/jobs/pi-orb-maint-owned', lambda value: fail('http', 'no storage')).error)
        self.assertEqual(calls, [])

    def test_unknown_execution_retains_operation_receipt_and_never_deletes(self):
        calls, edges = [], []
        class Cloud:
            def http(self, method, url, body=None):
                calls.append((method, url))
                if method == 'POST': return Result({'name': 'projects/p/locations/r/operations/operation-owned'})
                return fail('http', 'uncertain execution')
        result = execute(Cloud(), 'projects/p/locations/r/jobs/pi-orb-maint-owned', lambda value: edges.append(value) or Result())
        self.assertIsNotNone(result.error)
        self.assertEqual(edges[-1]['operation'], 'projects/p/locations/r/operations/operation-owned')
        self.assertFalse(any(method == 'DELETE' for method, url in calls))

    def test_success_requires_concrete_terminal_execution(self):
        for terminal in (False, True):
            edges = []
            class Cloud:
                def http(self, method, url, body=None):
                    if method == 'POST': return Result({'name': 'projects/p/locations/r/operations/operation-owned'})
                    return Result({'done': True, 'response': {'name': 'projects/p/locations/r/jobs/pi-orb-maint-owned/executions/e-owned',
                        'completionTime': '2026-10-05T00:00:00Z', 'succeededCount': 1 if terminal else 0,
                        'failedCount': 0, 'cancelledCount': 0, 'taskCount': 1}})
            result = execute(Cloud(), 'projects/p/locations/r/jobs/pi-orb-maint-owned', lambda value: edges.append(value) or Result())
            self.assertEqual(result.error is None, terminal)
            self.assertEqual(edges[-1]['execution']['taskCount'], 1)

    def test_operation_poll_is_bounded_without_rerun(self):
        clock, calls = [0], []
        class Cloud:
            def http(self, method, url, body=None):
                calls.append(method)
                return Result({'name': 'projects/p/locations/r/operations/operation-owned'})
        def sleep(seconds): clock[0] += seconds
        result = execute(Cloud(), 'projects/p/locations/r/jobs/pi-orb-maint-owned', lambda value: Result(),
                         monotonic=lambda: clock[0], sleep=sleep, limit=30)
        self.assertEqual(result.error.kind, 'timeout')
        self.assertEqual(calls.count('POST'), 1)


if __name__ == '__main__': unittest.main()
