import copy
import hashlib
import json
import unittest
from infra.release_state import Result, fail
from infra.release_maintenance import capture_config, fence, copy_receipt, provider_inventory
from infra.release_state_test import record


class Cloud:
    def __init__(self):
        self.calls = []
        self.revision = {'metadata': {'name': 'pi-orb-old', 'annotations': {
            'run.googleapis.com/network-interfaces': '[{"network":"network","subnetwork":"subnet"}]',
            'run.googleapis.com/vpc-access-egress': 'private-ranges-only'}}, 'spec': {
            'serviceAccountName': 'cp@test-project.iam.gserviceaccount.com',
            'containers': [{'image': 'old-image', 'env': [
                {'name': name, 'value': value} for name, value in {
                    'PI_ORB_HOST_PROVIDER': 'gce', 'PI_ORB_GCP_PROJECT': 'test-project',
                    'PI_ORB_GCE_ZONE': 'us-central1-a', 'PI_ORB_GCE_IMAGE_RESOURCE': 'old-resource',
                    'PI_ORB_GCE_IMAGE_ID': '123', 'PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE': 'workspace',
                    'PI_ORB_GCE_WORKSPACE_IMAGE_ID': '456', 'PI_ORB_HOST_SPEC_GENERATION': '7',
                    'PI_ORB_BROKER_URL': 'https://old-broker', 'PI_ORB_HOSTING_BUCKET': 'private-data',
                    'PI_ORB_GCE_MACHINE_TYPE': 'n2d-highmem-2', 'PI_ORB_GCE_SERVICE_ACCOUNT': 'vm@test',
                    'PI_ORB_GCE_SUBNETWORK': 'subnet',
                }.items()] + [{'name': 'DATABASE_URL', 'valueFrom': {'secretKeyRef': {'name': 'database', 'key': '1'}}},
                             {'name': 'PRIVATE_CONFIG', 'value': 'never-copy'}]}]}}
    def json(self, args):
        self.calls.append(args)
        if args[:3] == ['run', 'services', 'describe']:
            return Result({'status': {'traffic': [{'revisionName': 'pi-orb-old', 'percent': 100}]}})
        if args[:3] == ['run', 'revisions', 'describe']: return Result(copy.deepcopy(self.revision))
        if args[:3] == ['compute', 'instances', 'list']: return Result([])
        if args[:3] == ['compute', 'disks', 'list']: return Result([])
        if args[:3] == ['compute', 'operations', 'list']: return Result([])
        return Result([])
    def http(self, method, url): return Result({'timeSeries': []})
    def object(self, bucket, key): return Result({'generation': '42', 'body': {'generation': 7}})
    def put(self, *args): self.calls.append(args); return Result({'generation': '99'})


class MaintenanceTest(unittest.TestCase):
    def test_capture_old_hostspec_not_candidate_and_no_private_config(self):
        result = capture_config(Cloud(), record())
        self.assertIsNone(result.error)
        self.assertEqual(result.value['env']['PI_ORB_GCE_IMAGE_ID'], '123')
        self.assertNotIn('PRIVATE_CONFIG', result.value['env'])
        self.assertEqual(result.value['activeGeneration'], '42')

    def test_uncertain_traffic_or_generation_blocks_capture(self):
        for change in ('generation', 'image', 'secret'):
            cloud = Cloud()
            env = cloud.revision['spec']['containers'][0]['env']
            if change == 'generation': next(e for e in env if e['name'] == 'PI_ORB_HOST_SPEC_GENERATION')['value'] = '8'
            if change == 'image': env[:] = [e for e in env if e['name'] != 'PI_ORB_GCE_IMAGE_ID']
            if change == 'secret': next(e for e in env if e['name'] == 'DATABASE_URL')['value'] = 'private-payload'
            self.assertIsNotNone(capture_config(cloud, record()).error)

    def test_fence_intent_must_be_durable_before_delete(self):
        cloud = Cloud()
        result = fence(cloud, record(), ('pi-orb', 'pi-orb-ops'), lambda value: fail('http', 'storage unavailable'))
        self.assertIsNotNone(result.error)
        self.assertFalse(any(call[:3] == ['run', 'services', 'delete'] for call in cloud.calls))

    def test_no_broker_delete_in_first_fence_and_clock_after_delete(self):
        cloud = Cloud()
        edges = []
        result = fence(cloud, record(), ('pi-orb', 'pi-orb-ops'), lambda value: edges.append(copy.deepcopy(value)) or Result(),
                       wall=lambda: '2026-09-09T12:03:00Z', wait=lambda *args, **kwargs: Result(args[1]))
        self.assertIsNone(result.error)
        deletes = [c[3] for c in cloud.calls if c[:3] == ['run', 'services', 'delete']]
        self.assertEqual(deletes, ['pi-orb', 'pi-orb-ops'])
        self.assertEqual(edges[-1]['retirement']['after'], '2026-09-09T12:03:00Z')

    def test_receipt_requires_exact_generation_and_hash(self):
        cloud = Cloud()
        reference = {'receiptUri': 'gs://private-data/release-maintenance/release/before/receipt.json', 'generation': '42', 'sha256': '0'*64}
        self.assertIsNotNone(copy_receipt(cloud, record(), 'private-data', reference).error)
        self.assertFalse(cloud.calls)

    def test_receipt_copy_is_create_only_and_private(self):
        cloud = Cloud()
        value = record()
        body = {'releaseId': value['releaseId'], 'orbIds': ['private-orb']}
        cloud.object = lambda *args: Result({'generation': '42', 'body': body})
        reference = {'receiptUri': f"gs://private-data/release-maintenance/{value['releaseId']}/final/receipt.json", 'generation': '42',
                     'sha256': hashlib.sha256(json.dumps(body, separators=(',', ':')).encode()).hexdigest()}
        result = copy_receipt(cloud, value, 'private-data', reference)
        self.assertIsNone(result.error)
        self.assertEqual(cloud.calls[0][3], '0')
        self.assertEqual(cloud.calls[0][2], body)
        self.assertEqual(result.value['generation'], '99')
        self.assertNotIn('private-orb', str(result.value))
        reference['generation'] = '43'
        self.assertIsNotNone(copy_receipt(cloud, value, 'private-data', reference).error)
        self.assertEqual(len(cloud.calls), 1)

    def test_fence_failure_after_delete_never_waits_or_continues(self):
        cloud = Cloud()
        original = cloud.json
        def request(args):
            if args[:4] == ['run', 'services', 'delete', 'pi-orb-ops']:
                return fail('http', 'unknown deletion')
            return original(args)
        cloud.json = request
        waits = []
        result = fence(cloud, record(), ('pi-orb', 'pi-orb-ops'), lambda value: Result(),
                       wait=lambda *args, **kwargs: waits.append(args) or Result())
        self.assertIsNotNone(result.error)
        self.assertEqual(waits, [])
        self.assertTrue(any(call[:4] == ['run', 'services', 'delete', 'pi-orb'] for call in cloud.calls))

    def test_provider_inventory_requires_numeric_identity_and_rejects_pending(self):
        class ProviderCloud(Cloud):
            def json(self, args):
                if args[1] == 'instances': return Result([{'name': 'pi-orb-owned', 'id': '123', 'status': 'RUNNING', 'zone': 'zones/us-central1-a', 'labels': {'pi-orb-orb-id': 'owned'}}])
                if args[1] == 'operations': return Result([{'name': 'operation-old', 'status': 'RUNNING', 'targetLink': 'https://compute/projects/test-project/zones/us-central1-a/instances/pi-orb-owned'}])
                return Result([])
        cloud = ProviderCloud()
        self.assertIsNotNone(provider_inventory(cloud, record(), {'owned'}, require_stopped=True).error)
        original = cloud.json
        def request(args):
            found = original(args)
            if args[1] == 'instances': found.value[0]['status'] = 'TERMINATED'
            return found
        cloud.json = request
        self.assertIsNotNone(provider_inventory(cloud, record(), {'owned'}, require_stopped=True).error)
        self.assertIsNotNone(provider_inventory(cloud, record(), set()).error)


if __name__ == '__main__': unittest.main()
