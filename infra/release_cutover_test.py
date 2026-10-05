import unittest
from unittest.mock import patch
from infra.release_cutover import OLD_SERVICES, retire
from infra.release_state import Result, fail
from infra.release_state_test import record


class Cloud:
    def __init__(self, absent=(), failure=None):
        self.absent = set(absent)
        self.failure = failure
        self.calls = []
    def http(self, method, url, body=None):
        self.calls.append((method, url))
        name = url.split('/services/')[-1].split('?')[0]
        if method == 'POST': return Result({'permissions': ['run.services.delete']})
        if method == 'DELETE':
            if name == self.failure: return fail('http', 'delete failed')
            self.absent.add(name)
            return Result({'name': 'projects/test-project/locations/us-central1/operations/delete', 'done': True})
        if '/operations/' in url: return Result({'done': True})
        return Result(None if name in self.absent else {'name': url.split('/v2/')[1], 'uid': 'uid-' + name, 'etag': 'etag-' + name})


class CutoverTest(unittest.TestCase):
    def run_retire(self, cloud):
        checkpoints = []
        with patch('infra.release_cutover.inventory', side_effect=lambda _c, r, **_kw: Result(r)), patch('infra.release_cutover.wait_for_retirement', return_value=Result(record())) as wait:
            result = retire(cloud, record(), checkpoint=lambda r: checkpoints.append(r.copy()) or Result())
        return result, checkpoints, wait

    def test_exact_scope_and_order(self):
        cloud = Cloud()
        result, checkpoints, wait = self.run_retire(cloud)
        self.assertIsNone(result.error)
        deletes = [url for method, url in cloud.calls if method == 'DELETE']
        self.assertEqual(len(deletes), 3)
        for name, url in zip(OLD_SERVICES, deletes):
            self.assertTrue(url.endswith('/services/' + name + '?etag=etag-' + name))
        self.assertTrue(all(method == 'GET' for method, _ in cloud.calls[:4]))
        self.assertTrue(checkpoints)
        self.assertEqual(wait.call_args.kwargs['services'], OLD_SERVICES)

    def test_known_absence_is_checked_without_deleting(self):
        cloud = Cloud(OLD_SERVICES)
        result, _, wait = self.run_retire(cloud)
        self.assertIsNone(result.error)
        self.assertFalse(any(method == 'DELETE' for method, _ in cloud.calls))
        wait.assert_called_once()

    def test_partial_fence_fails_before_delete(self):
        cloud = Cloud(['pi-orb'])
        result, _, wait = self.run_retire(cloud)
        self.assertIsNotNone(result.error)
        self.assertFalse(any(method == 'DELETE' for method, _ in cloud.calls))
        wait.assert_not_called()

    def test_missing_issuer_and_changed_uid_fail_closed(self):
        cloud = Cloud(['pi-orb-issuer'])
        self.assertIsNotNone(self.run_retire(cloud)[0].error)
        self.assertFalse(any(method == 'DELETE' for method, _ in cloud.calls))
        cloud = Cloud()
        original = cloud.http
        def changed(method, url, body=None):
            result = original(method, url, body)
            if len(cloud.calls) > 4 and method == 'GET': result.value['uid'] = 'replacement'
            return result
        cloud.http = changed
        self.assertIsNotNone(self.run_retire(cloud)[0].error)
        self.assertFalse(any(method == 'DELETE' for method, _ in cloud.calls))

    def test_missing_delete_permission_precedes_every_delete(self):
        cloud = Cloud()
        original = cloud.http
        cloud.http = lambda method, url, body=None: Result({'permissions': []}) if method == 'POST' else original(method, url, body)
        self.assertIsNotNone(self.run_retire(cloud)[0].error)
        self.assertFalse(any(method == 'DELETE' for method, _ in cloud.calls))

    def test_partial_delete_failure_never_continues(self):
        cloud = Cloud(failure='pi-orb-ops')
        result, checkpoints, wait = self.run_retire(cloud)
        self.assertIsNotNone(result.error)
        self.assertEqual(len([1 for method, _ in cloud.calls if method == 'DELETE']), 2)
        self.assertTrue(checkpoints)
        wait.assert_not_called()


if __name__ == '__main__': unittest.main()
