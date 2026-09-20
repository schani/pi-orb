import copy
import unittest
from unittest.mock import patch
from infra.release_cutover import begin_observation, main, verify
from infra.release_retire_test import series
from infra.release_state import Result
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
