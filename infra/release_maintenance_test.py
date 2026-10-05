import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from infra.release_state import Result, fail
from infra.release_maintenance import capture_config, fence, copy_receipt, provider_inventory
from infra.release_state_test import record
from infra.release_consolidation import job_body, validate_envelope, guard_plan, detect, main, verify_workspaces


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
    def bytes(self, *args): return Result(b'{}')
    def copy_bytes(self, *args): self.calls.append((*args, '0')); return Result({'generation': '99'})


class MaintenanceTest(unittest.TestCase):
    def test_workspace_numeric_identity_is_preserved_except_disposal(self):
        before = {'disks': [{'orbId': 'owned', 'name': 'workspace', 'id': '123'}]}
        snapshot = {'orbs': [{'id': 'owned', 'state': 'running', 'disposal': None}]}
        self.assertIsNone(verify_workspaces(before, before, snapshot).error)
        self.assertIsNotNone(verify_workspaces(before, {'disks': [{'orbId': 'owned', 'name': 'workspace', 'id': '456'}]}, snapshot).error)
        snapshot['orbs'][0]['disposal'] = 'delete'
        self.assertIsNone(verify_workspaces(before, {'disks': []}, snapshot).error)

    def test_composed_drain_order_and_failure_boundaries(self):
        for failure_at in (None, 'controllers', 'drain', 'broker', 'final', 'provider'):
            events = []
            value = record()
            context = {'config': {}}
            class Durable:
                def replace(self, *args): return Result()
                def put(self, *args): return Result()
                def object(self, *args): return Result({'body': value['retirement']})
            def edge(name, result):
                events.append(name)
                return fail('conflict', 'injected') if name == failure_at else Result(result)
            with patch('infra.release_consolidation.PrivateCloud', return_value=Durable()), patch('infra.release_consolidation.load', side_effect=[Result(value), Result(context)]), patch('infra.release_consolidation.fence', side_effect=lambda c, r, services, checkpoint: edge('broker' if services == ('pi-orb-runtime-api',) else 'controllers', r)), patch('infra.release_consolidation.run_phase', side_effect=lambda c, r, config, phase, checkpoint, baseline=None: edge(phase, {'reference': {}, 'snapshot': {'orbs': []}})), patch('infra.release_consolidation.provider_inventory', side_effect=lambda *args, **kwargs: edge('provider', {'disks': []})), patch('infra.release_consolidation.save', return_value=Result()), patch('infra.release_consolidation.publish', return_value=Result()):
                self.assertEqual(main(['cmd', 'drain', 'record', 'context']), 0 if failure_at is None else 1)
            full = ['controllers', 'drain', 'broker', 'final', 'provider']
            self.assertEqual(events, full if failure_at is None else full[:full.index(failure_at) + 1])

    def test_detect_requires_explicit_first_mode_with_three_services(self):
        class Services:
            def json(self, args): return Result([{'metadata': {'name': name}} for name in ('pi-orb', 'pi-orb-ops', 'pi-orb-runtime-api', 'pi-orb-issuer')])
        self.assertIsNone(detect(Services(), record(), True).error)
        self.assertIsNotNone(detect(Services(), record(), False).error)

    def test_schema_preflight_is_read_only_command_with_pinned_mapping(self):
        config = capture_config(Cloud(), record()).value
        config['primaryUserId'] = 'verified-primary'
        body = job_body(record(), config, 'preflight-before', 'pi-orb-maint-preflight', None)
        container = body['template']['template']['containers'][0]
        self.assertEqual(container['args'], ['apps/control-plane/src/migrate.ts', '--check-consolidation'])
        self.assertIn({'name': 'PI_ORB_GOOGLE_IDENTITY_MAPPINGS', 'valueSource': {'secretKeyRef': {'secret': 'pi-orb-google-identity-mappings', 'version': '1'}}}, container['env'])
        self.assertIn({'name': 'PI_ORB_USER_ID', 'value': config['primaryUserId']}, container['env'])

    def test_jobs_are_headless_old_configuration_no_retries(self):
        config = capture_config(Cloud(), record()).value
        body = job_body(record(), config, 'drain', 'pi-orb-maint-drain', None)
        task = body['template']['template']
        self.assertEqual(task['maxRetries'], 0)
        self.assertEqual(task['serviceAccount'], config['serviceAccount'])
        container = task['containers'][0]
        self.assertIn('apps/control-plane/src/maintenance.ts', container['args'])
        self.assertEqual(next(e['value'] for e in container['env'] if e['name'] == 'PI_ORB_GCE_IMAGE_ID'), '123')
        self.assertFalse(any(e['name'] in ('PI_ORB_AUTH_MODE', 'PI_ORB_ROLE') for e in container['env']))

    def test_resume_requires_final_reference_and_unexposed_closure(self):
        config = capture_config(Cloud(), record()).value
        reference = {'receiptUri': 'gs://private-data/final.json', 'generation': '42', 'sha256': 'a'*64}
        body = job_body(record(), config, 'preapply-resume', 'pi-orb-maint-resume', reference)
        container = body['template']['template']['containers'][0]
        self.assertIn('--snapshot-generation', container['args'])
        self.assertIn({'name': 'PI_ORB_MAINTENANCE_CANDIDATE_EXPOSED', 'value': '0'}, container['env'])

    def test_saved_plan_allows_only_three_exact_legacy_service_deletes(self):
        for address, expected in [('google_cloud_run_v2_service.browser', True), ('google_cloud_run_v2_service.issuer', False), ('google_storage_bucket.hosting', False)]:
            plan = {'resource_changes': [{'address': address, 'type': address.split('.')[0], 'change': {'actions': ['delete'], 'before': {'name': 'pi-orb'}}}]}
            self.assertEqual(guard_plan(plan).error is None, expected)

    def test_receipt_binding_rejects_other_sha_and_unknown_fields(self):
        value = record()
        body = {'schemaVersion': 1, 'releaseId': value['releaseId'], 'sourceSha': value['commit'], 'executionId': 'job', 'mode': 'inventory', 'phase': 'before', 'outcome': 'sealed', 'counts': {'orbs': 0}, 'snapshot': {'releaseId': value['releaseId'], 'phase': 'before', 'projects': [], 'orbs': [], 'resumeCandidates': []}}
        self.assertIsNone(validate_envelope(value, body, 'before', 'job').error)
        body['sourceSha'] = '0'*40
        self.assertIsNotNone(validate_envelope(value, body, 'before', 'job').error)
        body['sourceSha'] = value['commit']
        body['privateConfig'] = 'forbidden'
        self.assertIsNotNone(validate_envelope(value, body, 'before', 'job').error)

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
        raw = json.dumps(body, indent=2).encode() + b'\n'
        cloud.bytes = lambda *args: Result(raw)
        reference = {'receiptUri': f"gs://private-data/release-maintenance/{value['releaseId']}/final/receipt.json", 'generation': '42',
                     'sha256': hashlib.sha256(raw).hexdigest()}
        result = copy_receipt(cloud, value, 'private-data', reference)
        self.assertIsNone(result.error)
        self.assertEqual(cloud.calls[0][3], '0')
        self.assertEqual(cloud.calls[0][2], raw)
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
