import copy
import unittest
from unittest.mock import patch
from infra.release_cutover import begin_observation, main, verify
from infra.release_retire import inventory, wait_for_retirement
from infra.release_retire_test import series
from infra.release_state import Result, validate_record
from infra.release_state_test import record


class Cloud:
    def __init__(self, services): self.services = services
    def json(self, args): return Result(self.services)


class CutoverTest(unittest.TestCase):
    def manifest(self):
        return {'project': 'test-project', 'region': 'us-central1', 'commit': 'b'*40,
                'recoveryPoint': 'backup-123', 'restorationIdentity': 'independent-admin',
                'fleetStopped': True, 'wakeIntentsReviewed': True,
                'retirement': record()['retirement']}

    def test_deleted_service_is_not_retirement_proof(self):
        value = self.manifest()
        value['retirement']['zeroes'] = {}
        self.assertIsNotNone(verify(Cloud([]), record(), value).error)

    def test_tagged_or_reactivatable_service_blocks_migration(self):
        for name in ['pi-orb', 'pi-orb-ops', 'pi-orb-runtime-api']:
            self.assertIsNotNone(verify(Cloud([{'metadata': {'name': name}}]), record(), self.manifest()).error)

    def test_wrong_target_and_unreviewed_recovery_fail_closed(self):
        for key, value in [('project', 'elsewhere'), ('commit', 'c'*40), ('fleetStopped', False), ('restorationIdentity', '')]:
            manifest = self.manifest(); manifest[key] = value
            self.assertIsNotNone(verify(Cloud([]), record(), manifest).error)

    def test_observation_requires_fencing_and_discards_pre_fence_zeroes(self):
        manifest = self.manifest()
        self.assertIsNotNone(begin_observation(Cloud([{'metadata': {'name': 'pi-orb'}}]), record(), manifest).error)
        result = begin_observation(Cloud([{'metadata': {'name': 'pi-orb-issuer'}}]), record(), manifest,
                                   wall=lambda: '2026-09-09T12:03:00Z')
        self.assertIsNone(result.error)
        self.assertEqual(result.value['retirement']['after'], '2026-09-09T12:03:00Z')
        self.assertEqual(result.value['retirement']['zeroes'], {})
        self.assertEqual(result.value['retirement']['revisions'], manifest['retirement']['revisions'])
        self.assertTrue(manifest['retirement']['zeroes'])

    def test_complete_evidence_admits_cutover(self):
        self.assertIsNone(verify(Cloud([{'metadata': {'name': 'pi-orb-issuer'}}]), record(), self.manifest()).error)

    def test_excluded_only_inventory_survives_observation_and_verification(self):
        class PipelineCloud:
            def __init__(self):
                self.points = [series('pi-orb-deleted', 'active', '1', '2026-09-09T11:58:00Z')]
                self.points += [series('pi-orb-deleted', state, '0', '2026-09-09T11:59:00Z') for state in ('active', 'idle')]
                self.operations = []
                self.writes = []
            def json(self, args):
                if args[0] == 'compute': return Result(self.operations)
                if args[1:3] == ['revisions', 'list']: return Result([])
                if args[2] == 'list': return Result([{'metadata': {'name': 'pi-orb-issuer'}}])
                return Result({'status': {'latestReadyRevisionName': 'pi-orb-issuer-old'}})
            def http(self, method, url):
                return Result({'timeSeries': self.points})
            def put(self, *args):
                self.writes.append(args)
                return Result()
        cloud = PipelineCloud()
        value = record()
        found = inventory(cloud, value, services=('pi-orb', 'pi-orb-ops', 'pi-orb-runtime-api'), wall=lambda: '2026-09-09T12:00:00Z')
        self.assertIsNone(found.error)
        manifest = self.manifest()
        manifest['retirement'] = found.value['retirement']
        self.assertEqual(manifest['retirement']['revisions'], [])
        self.assertEqual(set(manifest['retirement']['excluded']), {'pi-orb-deleted'})
        observed = begin_observation(cloud, value, manifest, wall=lambda: '2026-09-09T12:03:00Z')
        self.assertIsNone(observed.error)
        cloud.points = []
        self.assertIsNone(wait_for_retirement(cloud, observed.value, wall=lambda: '2026-09-09T12:04:00Z', limit=0).error)
        manifest['retirement'] = observed.value['retirement']
        self.assertTrue(validate_record({**value, 'retirement': manifest['retirement']}))
        self.assertIsNone(verify(cloud, value, manifest).error)
        for change in ('empty', 'overlap', 'utc', 'state', 'pending'):
            with self.subTest(change=change):
                invalid = copy.deepcopy(manifest)
                proof = invalid['retirement']
                if change == 'empty': proof['excluded'] = {}
                if change == 'overlap': proof['revisions'] = ['pi-orb-deleted']
                if change == 'utc': proof['excluded']['pi-orb-deleted']['idle'] = '2026-02-30T11:59:00Z'
                if change == 'state': del proof['excluded']['pi-orb-deleted']['idle']
                if change == 'pending': proof['operations'] = ['operation-old']
                self.assertIsNotNone(verify(cloud, value, invalid).error)
        operation = {'name': 'operation-old', 'status': 'RUNNING', 'targetLink': 'https://www.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a/instances/pi-orb-old'}
        for change in ('none', 'positive', 'pending'):
            with self.subTest(recheck=change):
                cloud.points = [series('pi-orb-deleted', 'active', '1', '2026-09-09T12:04:00Z')] if change == 'positive' else []
                cloud.operations = [operation] if change == 'pending' else []
                cloud.writes = []
                with patch('infra.release_cutover.Cloud', return_value=cloud), patch('infra.release_cutover.load', side_effect=[Result(value), Result(copy.deepcopy(manifest))]), patch('infra.release_cutover.save', return_value=Result()), patch('infra.release_cutover.publish', return_value=Result()), patch('infra.release_cutover.wait_for_retirement', side_effect=lambda cloud, candidate, **kwargs: wait_for_retirement(cloud, candidate, wall=lambda: '2026-09-09T12:05:00Z', **kwargs)):
                    self.assertEqual(main(['cutover', 'verify', 'record', 'manifest']), 0 if change == 'none' else 1)
                self.assertEqual(len(cloud.writes), 1 if change == 'none' else 0)

    def test_recheck_rejects_delayed_writer_and_preserves_issuer_retirement(self):
        for delayed_writer in (True, False):
            value = record()
            value['serving'] = None
            manifest = self.manifest()
            before = copy.deepcopy(manifest)
            writes = []
            class LiveCloud:
                def json(self, args):
                    if args[0] == 'compute': return Result([])
                    if args[2] == 'list': return Result([{'metadata': {'name': 'pi-orb-issuer'}}])
                    return Result({'status': {'latestReadyRevisionName': 'pi-orb-issuer-old'}})
                def http(self, method, url):
                    points = [series('pi-orb-old', 'active', '1', '2026-09-09T12:02:00Z')] if delayed_writer else []
                    return Result({'timeSeries': points})
                def put(self, *args):
                    writes.append(args)
                    return Result()
            def store(path, candidate):
                writes.append(copy.deepcopy(candidate))
                return Result()
            with patch('infra.release_cutover.Cloud', return_value=LiveCloud()), patch('infra.release_cutover.load', side_effect=[Result(value), Result(manifest)]), patch('infra.release_cutover.save', side_effect=store), patch('infra.release_cutover.publish', return_value=Result()):
                self.assertEqual(main(['cutover', 'verify', 'record', 'manifest']), 1 if delayed_writer else 0)
            self.assertEqual(manifest, before)
            if delayed_writer:
                self.assertEqual(writes, [])
            else:
                self.assertEqual(writes[0][3], '0')
                self.assertIn('pi-orb-issuer-old', writes[1]['retirement']['revisions'])
                self.assertNotIn('pi-orb-issuer-old', writes[1]['retirement']['zeroes'])
