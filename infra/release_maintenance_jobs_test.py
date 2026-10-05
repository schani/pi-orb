import unittest
from infra.release_state import Result, fail
from infra.release_maintenance_jobs import execute


class JobsTest(unittest.TestCase):
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
