"""Private first-consolidation boundaries; no inventory payloads on stdout."""
import copy
import hashlib
import json
import re
from infra.release_state import Result, fail, now, valid_id
from infra.release_retire import inventory, wait_for_retirement, pending_operations

VALUE_ENV = frozenset('''PI_ORB_HOST_PROVIDER PI_ORB_GCP_PROJECT PI_ORB_GCE_ZONE
PI_ORB_GCE_MACHINE_TYPE PI_ORB_GCE_SERVICE_ACCOUNT PI_ORB_GCE_SUBNETWORK
PI_ORB_GCE_IMAGE_RESOURCE PI_ORB_GCE_IMAGE_ID PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE
PI_ORB_GCE_WORKSPACE_IMAGE_ID PI_ORB_HOST_SPEC_GENERATION PI_ORB_BROKER_URL
PI_ORB_HOSTING_BUCKET PI_ORB_TAILSCALE_OAUTH_CLIENT_ID PI_ORB_TAILSCALE_TAILNET_DNS_NAME'''.split())
REQUIRED_ENV = VALUE_ENV - {'PI_ORB_TAILSCALE_OAUTH_CLIENT_ID', 'PI_ORB_TAILSCALE_TAILNET_DNS_NAME'}
SECRET_ENV = frozenset(('DATABASE_URL', 'PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET'))


def capture_config(cloud, record):
    """Read metadata/bindings only. Never obtain a secret version's payload."""
    service = cloud.json(['run', 'services', 'describe', 'pi-orb', '--project', record['project'], '--region', record['region']])
    if service.error:
        return service
    status = service.value.get('status', {}) if isinstance(service.value, dict) else {}
    traffic = status.get('traffic')
    if not isinstance(traffic, list) or not traffic:
        return fail('invalid', 'old browser traffic is unknown')
    revisions = {entry.get('revisionName') for entry in traffic if isinstance(entry, dict)}
    if len(revisions) != 1 or not all(isinstance(e, dict) for e in traffic) or not valid_id(next(iter(revisions), None)) or sum(e.get('percent', 0) for e in traffic if type(e.get('percent', 0)) is int) != 100:
        return fail('conflict', 'old browser has ambiguous serving revisions')
    revision = next(iter(revisions))
    found = cloud.json(['run', 'revisions', 'describe', revision, '--project', record['project'], '--region', record['region']])
    if found.error:
        return found
    spec = found.value.get('spec') if isinstance(found.value, dict) else None
    if not isinstance(spec, dict) or not isinstance(spec.get('containers'), list) or len(spec['containers']) != 1:
        return fail('invalid', 'old revision container is unknown')
    container = spec['containers'][0]
    if not isinstance(container, dict) or not isinstance(container.get('env'), list) or not isinstance(container.get('image'), str) or not container['image']:
        return fail('invalid', 'old revision bindings are unknown')
    env, secrets = {}, {}
    for binding in container['env']:
        if not isinstance(binding, dict) or not isinstance(binding.get('name'), str):
            return fail('invalid', 'malformed revision binding')
        name = binding['name']
        if name not in VALUE_ENV | SECRET_ENV:
            continue
        if name in env or name in secrets:
            return fail('invalid', 'duplicate revision binding')
        if name in VALUE_ENV:
            if not isinstance(binding.get('value'), str) or not binding['value'] or 'valueFrom' in binding:
                return fail('invalid', 'host configuration must be explicit')
            env[name] = binding['value']
        else:
            source = binding.get('valueFrom')
            reference = source.get('secretKeyRef') if isinstance(source, dict) else None
            if 'value' in binding or not isinstance(reference, dict) or not valid_id(reference.get('name')) or not isinstance(reference.get('key'), str):
                return fail('invalid', 'secret binding must reference a version')
            version = reference['key']
            if version == 'latest':
                metadata = cloud.json(['secrets', 'versions', 'describe', 'latest', '--secret', reference['name'], '--project', record['project']])
                if metadata.error:
                    return metadata
                if not isinstance(metadata.value, dict) or metadata.value.get('state') != 'ENABLED':
                    return fail('invalid', 'old secret version is unavailable')
                version = str(metadata.value.get('name', '')).rsplit('/', 1)[-1]
            if not version.isdigit():
                return fail('invalid', 'secret version must be pinned')
            secrets[name] = {'secret': reference['name'], 'version': version}
    if not REQUIRED_ENV <= env.keys() or 'DATABASE_URL' not in secrets or env['PI_ORB_HOST_PROVIDER'] != 'gce' or env['PI_ORB_GCP_PROJECT'] != record['project'] or env['PI_ORB_GCE_ZONE'] != record['zone']:
        return fail('invalid', 'incomplete old host configuration')
    for name in ('PI_ORB_GCE_IMAGE_ID', 'PI_ORB_GCE_WORKSPACE_IMAGE_ID', 'PI_ORB_HOST_SPEC_GENERATION'):
        if not env[name].isdigit():
            return fail('invalid', 'old immutable host identity is unknown')
    if ('PI_ORB_TAILSCALE_OAUTH_CLIENT_ID' in env) != ('PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET' in secrets):
        return fail('invalid', 'incomplete old Tailscale binding')
    active = cloud.object(f"pi-orb-tfstate-{record['project']}", 'static-plane/releases/active.json')
    if active.error:
        return active
    if not isinstance(active.value, dict) or not isinstance(active.value.get('body'), dict) or type(active.value['body'].get('generation')) is not int or str(active.value['body']['generation']) != env['PI_ORB_HOST_SPEC_GENERATION']:
        return fail('conflict', 'old host generation differs from active authority')
    account = spec.get('serviceAccountName')
    metadata = found.value.get('metadata')
    annotations = metadata.get('annotations') if isinstance(metadata, dict) else None
    if not isinstance(account, str) or not account or not isinstance(annotations, dict) or annotations.get('run.googleapis.com/vpc-access-egress') != 'private-ranges-only':
        return fail('invalid', 'old revision execution identity or network is unknown')
    try:
        interfaces = json.loads(annotations.get('run.googleapis.com/network-interfaces', ''))
    except (TypeError, ValueError):
        return fail('invalid', 'old revision network interfaces are unknown')
    if not isinstance(interfaces, list) or len(interfaces) != 1 or not isinstance(interfaces[0], dict) or any(not isinstance(interfaces[0].get(key), str) or not interfaces[0][key] for key in ('network', 'subnetwork')):
        return fail('invalid', 'old revision network interfaces are unknown')
    network = {'networkInterfaces': [{key: interfaces[0][key] for key in ('network', 'subnetwork')}], 'egress': 'PRIVATE_RANGES_ONLY'}
    return Result({'revision': revision, 'image': container['image'], 'env': env, 'secrets': secrets, 'serviceAccount': account,
                   'vpcAccess': copy.deepcopy(network), 'activeGeneration': active.value['generation'],
                   'active': copy.deepcopy(active.value['body'])})


def fence(cloud, record, services, checkpoint, *, wall=now, wait=wait_for_retirement):
    """Caller retains global lock before invocation, including failed deletes."""
    if tuple(services) not in (('pi-orb', 'pi-orb-ops'), ('pi-orb-runtime-api',)):
        return fail('invalid', 'invalid first-consolidation fence')
    candidate = copy.deepcopy(record)
    found = inventory(cloud, candidate, services=services)
    if found.error:
        return found
    stored = checkpoint(candidate)
    if stored.error:
        return stored
    for service in services:
        deleted = cloud.json(['run', 'services', 'delete', service, '--project', record['project'], '--region', record['region'], '--quiet'])
        if deleted.error:
            return deleted
    candidate['retirement']['after'] = wall()
    candidate['retirement']['zeroes'] = {}
    stored = checkpoint(candidate)
    if stored.error:
        return stored
    return wait(cloud, candidate, checkpoint=checkpoint, services=services)


def provider_inventory(cloud, record, orb_ids, *, require_stopped=False):
    """Only owned resources, projected numeric identities; no VM metadata."""
    result = {'instances': [], 'disks': []}
    if not isinstance(orb_ids, set) or any(not isinstance(orb, str) or not orb for orb in orb_ids):
        return fail('invalid', 'orb ownership inventory is required')
    for resource in result:
        found = cloud.json(['compute', resource, 'list', '--project', record['project'], '--filter=labels.pi-orb-orb-id:*'])
        if found.error:
            return found
        if not isinstance(found.value, list):
            return fail('invalid', 'invalid provider inventory')
        for item in found.value:
            if not isinstance(item, dict) or not isinstance(item.get('labels'), dict):
                return fail('invalid', 'provider ownership label is unknown')
            owner = item['labels'].get('pi-orb-orb-id')
            if owner not in orb_ids:
                return fail('conflict', 'provider resource has no inventoried owner')
            if not valid_id(item.get('name')) or not isinstance(item.get('id'), str) or not item['id'].isdigit() or not isinstance(item.get('zone'), str) or not isinstance(item.get('status'), str):
                return fail('invalid', 'provider numeric identity is unknown')
            if require_stopped and resource == 'instances' and item['status'] != 'TERMINATED':
                return fail('conflict', 'live compute remains after drain')
            projected = {key: item[key] for key in ('name', 'id', 'zone', 'status')}
            projected['orbId'] = owner
            if resource == 'instances':
                attached = item.get('disks', [])
                if not isinstance(attached, list) or any(not isinstance(disk, dict) or not isinstance(disk.get('source'), str) for disk in attached):
                    return fail('invalid', 'attached disk identity is unknown')
                projected['disks'] = [{'source': disk['source'], 'boot': disk.get('boot') is True} for disk in attached]
            result[resource].append(projected)
        result[resource].sort(key=lambda item: (item['zone'], item['name']))
    operations = pending_operations(cloud, record['project'])
    if operations.error:
        return operations
    if require_stopped and operations.value:
        return fail('conflict', 'provider operations remain after drain')
    result['operations'] = operations.value
    return Result(result)


def copy_receipt(cloud, record, app_bucket, reference):
    """Copy an exact immutable application receipt to release authority."""
    if not isinstance(reference, dict) or not isinstance(reference.get('receiptUri'), str):
        return fail('invalid', 'maintenance receipt reference is required')
    prefix = f"gs://{app_bucket}/release-maintenance/{record['releaseId']}/"
    uri = reference['receiptUri']
    if not uri.startswith(prefix) or not re.fullmatch(r'[0-9a-f]{64}', str(reference.get('sha256', ''))) or not isinstance(reference.get('generation'), str) or not reference['generation'].isdigit():
        return fail('invalid', 'maintenance receipt target differs from release')
    key = uri[len(f'gs://{app_bucket}/'):]
    found = cloud.object(app_bucket, key)
    if found.error:
        return found
    if not isinstance(found.value, dict) or found.value.get('generation') != reference['generation']:
        return fail('conflict', 'maintenance receipt generation changed')
    body = found.value['body']
    digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    if digest != reference['sha256']:
        return fail('conflict', 'maintenance receipt hash differs')
    suffix = uri[len(prefix):]
    target = f"static-plane/releases/{record['releaseId']}/maintenance/{suffix}"
    stored = cloud.put(f"pi-orb-tfstate-{record['project']}", target, body, '0')
    if stored.error:
        return stored
    return Result({'receiptUri': f"gs://pi-orb-tfstate-{record['project']}/{target}",
                   'generation': str(stored.value['generation']), 'sha256': digest})
