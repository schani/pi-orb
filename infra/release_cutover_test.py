import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
from infra.release_cutover import OLD_SERVICES, retire
from infra.release_state import Result, fail
from infra.release_state_test import record
from infra.release_retire_test import series
from infra.release_retire import wait_for_retirement


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


class ObservedCloud(Cloud):
    def __init__(self, late_ops=False, metric_failure=False):
        super().__init__()
        self.clock = 0
        self.late_ops = late_ops
        self.metric_failure = metric_failure

    def wall(self):
        return (datetime(2026, 9, 9, 12, tzinfo=timezone.utc) + timedelta(seconds=self.clock)).isoformat(timespec='seconds').replace('+00:00', 'Z')

    def sleep(self, duration):
        self.clock += duration

    def json(self, args):
        if args[0] == 'compute': return Result([])
        name = args[4]
        if name in self.absent: return Result([])
        return Result([{'metadata': {'name': name + '-current'}}] + [
            {'metadata': {'name': name + '-old-' + str(i)}} for i in range(52)
        ])

    def http(self, method, url, body=None):
        if 'monitoring.googleapis.com' in url:
            self.calls.append((method, url))
            if self.metric_failure: return fail('http', 'Monitoring unavailable')
            query = parse_qs(urlsplit(url).query)
            name = next(name for name in (*OLD_SERVICES, 'pi-orb-issuer') if f'service_name="{name}"' in query['filter'][0])
            points = []
            if name in ('pi-orb', 'pi-orb-runtime-api'):
                points = [series(name + '-current', state, value, stamp, service=name)
                          for state, value, stamp in [('active', '1', '2026-09-09T11:57:00Z'), ('idle', '0', '2026-09-09T11:57:00Z')]]
                if self.clock >= 121:
                    points += [series(name + '-current', state, '0', '2026-09-09T12:00:01Z', service=name) for state in ('active', 'idle')]
            if name == 'pi-orb-ops' and self.late_ops and self.clock >= 122:
                points = [series(name + '-current', 'active', '1', '2026-09-09T12:00:02Z', service=name)]
                if self.clock >= 140:
                    points += [series(name + '-current', state, '0', '2026-09-09T12:00:20Z', service=name) for state in ('active', 'idle')]
            return Result({'timeSeries': [p for p in points if query['interval.startTime'][0] <= p['points'][0]['interval']['endTime'] <= query['interval.endTime'][0]]})
        if method == 'DELETE': self.clock += 1
        return super().http(method, url, body)


class CutoverObservationTest(unittest.TestCase):
    def retire(self, cloud):
        value = record()
        value['serving'] = None
        checkpoints = []
        def wait(c, r, **kwargs):
            self.assertTrue(all(key in kwargs for key in ('wall', 'monotonic', 'sleep')))
            return wait_for_retirement(c, r, **kwargs, limit=195)
        with patch('infra.release_cutover.wait_for_retirement', side_effect=wait):
            result = retire(cloud, value, checkpoint=lambda r: checkpoints.append(r['retirement'].copy()) or Result(),
                            wall=cloud.wall, monotonic=lambda: cloud.clock, sleep=cloud.sleep)
        return result, checkpoints

    def test_retained_metadata_and_cold_ops_do_not_require_new_emission(self):
        cloud = ObservedCloud()
        result, checkpoints = self.retire(cloud)
        self.assertIsNone(result.error)
        self.assertEqual(cloud.clock, 183)
        proof = result.value['retirement']
        self.assertEqual(proof['after'], '2026-09-09T12:00:00Z')
        self.assertEqual(set(proof['revisions']), {'pi-orb-current', 'pi-orb-runtime-api-current'})
        self.assertEqual(set(proof['zeroes']), set(proof['revisions']))
        self.assertNotIn('pi-orb-ops-current', proof['zeroes'])
        self.assertTrue(proof['resourcesRetired'])
        self.assertEqual(len(proof['resources']), 159)
        self.assertTrue(checkpoints)

    def test_late_cold_start_requires_both_explicit_zero_states(self):
        cloud = ObservedCloud(late_ops=True)
        result, checkpoints = self.retire(cloud)
        self.assertIsNone(result.error)
        self.assertGreaterEqual(cloud.clock, 20)
        self.assertIn('pi-orb-ops-current', result.value['retirement']['zeroes'])
        self.assertTrue(any('pi-orb-ops-current' in c['revisions'] and 'pi-orb-ops-current' not in c['zeroes'] for c in checkpoints))

    def test_monitoring_failure_prevents_service_deletion(self):
        cloud = ObservedCloud(metric_failure=True)
        result, _ = self.retire(cloud)
        self.assertEqual(result.error.kind, 'http')
        self.assertFalse(any(method == 'DELETE' for method, _ in cloud.calls))

    def test_delayed_preinventory_positive_is_not_lost(self):
        cloud = ObservedCloud(late_ops=True)
        original = cloud.http
        def delayed(method, url, body=None):
            found = original(method, url, body)
            if 'monitoring.googleapis.com' in url and cloud.clock >= 122:
                for point in found.value.get('timeSeries', []):
                    if point['resource']['labels']['service_name'] == 'pi-orb-ops' and point['points'][0]['value']['int64Value'] == '1':
                        point['points'][0]['interval']['endTime'] = '2026-09-09T11:59:59Z'
            return found
        cloud.http = delayed
        result, checkpoints = self.retire(cloud)
        self.assertIsNone(result.error)
        self.assertTrue(any('pi-orb-ops-current' in c['revisions'] and 'pi-orb-ops-current' not in c['zeroes'] for c in checkpoints))

    def test_remaining_resource_blocks_retirement_even_with_zero_counts(self):
        cloud = ObservedCloud()
        original = cloud.json
        def retained(args):
            if args[0] == 'run' and args[4] == 'pi-orb-ops' and 'pi-orb-ops' in cloud.absent:
                return Result([{'metadata': {'name': 'pi-orb-ops-retained'}}])
            return original(args)
        cloud.json = retained
        result, checkpoints = self.retire(cloud)
        self.assertEqual(result.error.kind, 'conflict')
        self.assertFalse(checkpoints[-1]['resourcesRetired'])

    def test_late_preinventory_stop_keeps_its_explicit_zero_proof(self):
        cloud = ObservedCloud(late_ops=True)
        original = cloud.http
        def delayed(method, url, body=None):
            found = original(method, url, body)
            if 'monitoring.googleapis.com' in url:
                for point in found.value.get('timeSeries', []):
                    if point['resource']['labels']['service_name'] == 'pi-orb-ops':
                        value = point['points'][0]['value']['int64Value']
                        point['points'][0]['interval']['endTime'] = '2026-09-09T11:59:58Z' if value == '1' else '2026-09-09T11:59:59Z'
            return found
        cloud.http = delayed
        result, checkpoints = self.retire(cloud)
        self.assertIsNone(result.error)
        proof = result.value['retirement']
        self.assertNotIn('pi-orb-ops-current', proof['revisions'])
        self.assertEqual(proof['excluded']['pi-orb-ops-current'], {'active': '2026-09-09T11:59:59Z', 'idle': '2026-09-09T11:59:59Z'})
        self.assertTrue(any('pi-orb-ops-current' in c['revisions'] for c in checkpoints))


if __name__ == '__main__': unittest.main()
