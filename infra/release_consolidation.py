"""Actions-owned first consolidation. Private evidence never travels through logs."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.parse
from infra.release_state import Cloud, Result, fail, load, save, publish, validate_record, parse_json
from infra.release_maintenance import capture_config, fence, provider_inventory
from infra.release_maintenance_jobs import execute, wait_created
from infra.release_retire import inventory, wait_for_retirement

OLD = {'pi-orb', 'pi-orb-ops', 'pi-orb-runtime-api'}
MODES = {'before': 'inventory', 'drain': 'drain', 'final': 'inventory', 'preapply-resume': 'resume'}
ORB_FIELDS = {'id', 'projectId', 'state', 'stateVersion', 'hostRef', 'hostIncarnation', 'replicationCursor', 'replicatedHeadId', 'sleepId', 'sleepUntil', 'discardThrough', 'disposal', 'historySealedAt', 'cleanupAfter', 'messages'}


def detect(cloud, record, first):
    found = cloud.json(['run', 'services', 'list', '--project', record['project'], '--region', record['region']])
    if found.error:
        return found
    if not isinstance(found.value, list) or any(not isinstance(s, dict) or not isinstance(s.get('metadata'), dict) or not isinstance(s['metadata'].get('name'), str) for s in found.value):
        return fail('invalid', 'service inventory is unknown')
    names = {s['metadata']['name'] for s in found.value}
    if (first and not OLD <= names) or (not first and OLD & names) or 'pi-orb-issuer' not in names:
        return fail('conflict', 'legacy services require explicit first-consolidation mode before release')
    return Result()


def guard_plan(plan):
    if not isinstance(plan, dict) or not isinstance(plan.get('resource_changes'), list):
        return fail('invalid', 'saved plan changes are unknown')
    for item in plan['resource_changes']:
        if 'delete' not in item.get('change', {}).get('actions', []):
            continue
        # These two removed grants revoke authority, not data/resources.
        if item.get('address') in {'google_cloud_run_v2_service_iam_member.ops_debug_invoker', 'google_secret_manager_secret_iam_member.issuer_reads_database_url'} and item['change']['actions'] == ['delete']:
            continue
        if item.get('type') != 'google_cloud_run_v2_service' or item.get('address') not in {'google_cloud_run_v2_service.browser', 'google_cloud_run_v2_service.ops', 'google_cloud_run_v2_service.runtime'} or item['change'].get('before', {}).get('name') not in OLD or item['change']['actions'] != ['delete']:
            return fail('conflict', 'saved plan deletes a protected resource')
    return Result()


def validate_envelope(record, body, phase, execution_id, *, snapshot_phase=None):
    fields = {'schemaVersion', 'releaseId', 'sourceSha', 'executionId', 'mode', 'phase', 'outcome', 'snapshot', 'counts'}
    if not isinstance(body, dict) or set(body) != fields or body['schemaVersion'] != 1 or body['releaseId'] != record['releaseId'] or body['sourceSha'] != record['commit'] or body['executionId'] != execution_id or body['phase'] != phase or body['mode'] != MODES[phase] or body['outcome'] != 'sealed':
        return fail('invalid', 'maintenance receipt binding differs')
    snapshot = body['snapshot']
    if not isinstance(snapshot, dict) or set(snapshot) != {'releaseId', 'phase', 'projects', 'orbs', 'resumeCandidates'} or snapshot['releaseId'] != record['releaseId'] or snapshot['phase'] != (snapshot_phase or phase):
        return fail('invalid', 'maintenance snapshot binding differs')
    if any(not isinstance(snapshot[key], list) for key in ('projects', 'orbs', 'resumeCandidates')):
        return fail('invalid', 'maintenance inventory is unknown')
    for project in snapshot['projects']:
        if not isinstance(project, dict) or set(project) != {'id', 'ownerUserId'} or not all(isinstance(v, str) for v in project.values()):
            return fail('invalid', 'maintenance project schema differs')
    ids = set()
    for orb in snapshot['orbs']:
        if not isinstance(orb, dict) or set(orb) != ORB_FIELDS or not isinstance(orb['id'], str) or orb['id'] in ids or type(orb['stateVersion']) is not int or orb['stateVersion'] < 0 or type(orb['hostIncarnation']) is not int or not isinstance(orb['messages'], list):
            return fail('invalid', 'maintenance orb schema differs')
        if not isinstance(orb['projectId'], str) or orb['state'] not in ('creating', 'starting', 'running', 'stopping', 'stopped', 'failed', 'archiving', 'archived', 'deleting') or orb['disposal'] not in (None, 'archive', 'delete'):
            return fail('invalid', 'maintenance orb intent schema differs')
        if any(orb[key] is not None and not isinstance(orb[key], str) for key in ('hostRef', 'replicationCursor', 'replicatedHeadId', 'sleepId')) or any(orb[key] is not None and type(orb[key]) is not int for key in ('sleepUntil', 'discardThrough', 'historySealedAt', 'cleanupAfter')):
            return fail('invalid', 'maintenance orb field schema differs')
        ids.add(orb['id'])
        if any(not isinstance(m, dict) or set(m) != {'id', 'wake'} or not isinstance(m['id'], str) or type(m['wake']) is not bool for m in orb['messages']):
            return fail('invalid', 'maintenance wake schema differs')
    for candidate in snapshot['resumeCandidates']:
        if not isinstance(candidate, dict) or set(candidate) != {'orbId', 'stateVersion'} or candidate['orbId'] not in ids or type(candidate['stateVersion']) is not int:
            return fail('invalid', 'maintenance resume schema differs')
    if not isinstance(body['counts'], dict) or not set(body['counts']) <= {'projects', 'orbs', 'resumeCandidates', 'resumed', 'deferred'} or any(type(v) is not int or v < 0 for v in body['counts'].values()):
        return fail('invalid', 'maintenance counts are unknown')
    return Result(snapshot)


def verify_workspaces(before, after, snapshot):
    current = {(disk['orbId'], disk['name']): disk['id'] for disk in after['disks']}
    preserved = {orb['id'] for orb in snapshot['orbs'] if orb['disposal'] is None and orb['state'] not in ('archived', 'archiving', 'deleting')}
    if any(disk['orbId'] in preserved and current.get((disk['orbId'], disk['name'])) != disk['id'] for disk in before['disks']):
        return fail('conflict', 'workspace disk numeric identity changed')
    return Result()


def job_body(record, config, phase, execution_id, baseline):
    env = [{'name': key, 'value': value} for key, value in config['env'].items()]
    env += [{'name': key, 'valueSource': {'secretKeyRef': value}} for key, value in config['secrets'].items()]
    env += [{'name': 'PI_ORB_MAINTENANCE_EXECUTION_ID', 'value': execution_id}, {'name': 'PI_ORB_MAINTENANCE_SOURCE_SHA', 'value': record['commit']}]
    if phase == 'preapply-resume':
        env += [{'name': 'PI_ORB_MAINTENANCE_LEGACY_WRITERS_RETIRED', 'value': '1'}, {'name': 'PI_ORB_MAINTENANCE_CANDIDATE_EXPOSED', 'value': '0'}]
    if phase.startswith('preflight-'):
        env += [{'name': 'PI_ORB_USER_ID', 'value': config['primaryUserId']}, {'name': 'PI_ORB_GOOGLE_IDENTITY_MAPPINGS', 'valueSource': {'secretKeyRef': {'secret': 'pi-orb-google-identity-mappings', 'version': '1'}}}]
        args = ['apps/control-plane/src/migrate.ts', '--check-consolidation']
    else:
        args = ['apps/control-plane/src/maintenance.ts', MODES[phase], '--release-id', record['releaseId'], '--phase', phase]
    if baseline:
        for flag, key in (('uri', 'receiptUri'), ('generation', 'generation'), ('sha256', 'sha256')):
            args += ['--snapshot-' + flag, baseline[key]]
    return {'template': {'taskCount': 1, 'parallelism': 1, 'template': {'serviceAccount': config['serviceAccount'], 'vpcAccess': config['vpcAccess'], 'maxRetries': 0, 'timeout': '1800s', 'containers': [{'image': record['artifacts']['control_plane_image'], 'command': ['node'], 'args': args, 'env': env, 'resources': {'limits': {'cpu': '1', 'memory': '512Mi'}}}]}}}


class PrivateCloud(Cloud):
    def bytes(self, bucket, key, generation):
        return self.run(['gcloud', 'storage', 'cat', f'gs://{bucket}/{key}#{generation}'])

    def copy_bytes(self, bucket, key, body):
        try:
            with tempfile.TemporaryDirectory(prefix='release-receipt-') as directory:
                path = Path(directory) / 'receipt.json'
                path.write_bytes(body)
                path.chmod(0o600)
                stored = self.run(['gcloud', 'storage', 'cp', str(path), f'gs://{bucket}/{key}', '--if-generation-match=0', '--quiet'])
        except OSError:
            return fail('io', 'cannot stage private receipt')
        if stored.error:
            return stored
        metadata = self.json(['storage', 'objects', 'describe', f'gs://{bucket}/{key}'])
        if metadata.error or not isinstance(metadata.value, dict) or not str(metadata.value.get('generation', '')).isdigit():
            return metadata if metadata.error else fail('invalid', 'copied receipt generation is unknown')
        generation = str(metadata.value['generation'])
        verified = self.bytes(bucket, key, generation)
        if verified.error or verified.value != body:
            return verified if verified.error else fail('conflict', 'copied receipt bytes differ')
        return Result({'generation': generation})


def run_phase(cloud, record, config, phase, checkpoint, baseline=None, *, tag=None):
    job_id = f"pi-orb-maint-{tag or phase}-{record['releaseId']}"[:63]
    persist = checkpoint
    checkpoint = lambda value: persist({**value, 'phase': tag or phase})
    parent = f"projects/{record['project']}/locations/{record['region']}"
    job = f'{parent}/jobs/{job_id}'
    existing = cloud.http('GET', f'https://run.googleapis.com/v2/{job}')
    if existing.error or existing.value is not None:
        return existing if existing.error else fail('conflict', 'phase job already exists; inspect, never replay')
    stored = checkpoint({'phase': phase, 'job': job, 'state': 'create-requested'})
    if stored.error:
        return stored
    created = cloud.http('POST', f'https://run.googleapis.com/v2/{parent}/jobs?jobId={job_id}', job_body(record, config, phase, job_id, baseline))
    if created.error:
        return created
    ready = wait_created(cloud, job, created.value, lambda value: checkpoint({'phase': phase, **value}))
    if ready.error:
        return ready
    prior = cloud.http('GET', f'https://run.googleapis.com/v2/{job}/executions?pageSize=1')
    if prior.error or not isinstance(prior.value, dict) or prior.value.get('executions') or prior.value.get('nextPageToken'):
        return prior if prior.error else fail('conflict', 'job has an existing or unknown execution; never replay')
    ran = execute(cloud, job, lambda value: checkpoint({'phase': phase, **value}))
    if ran.error:
        return ran
    if phase.startswith('preflight-'):
        stored = cloud.put(f"pi-orb-tfstate-{record['project']}", f"static-plane/releases/{record['releaseId']}/maintenance/{phase}-ack.json", ran.value, '0')
        if stored.error:
            return stored
        return cloud.json(['run', 'jobs', 'delete', job_id, '--project', record['project'], '--region', record['region'], '--quiet'])
    bucket = config['env']['PI_ORB_HOSTING_BUCKET']
    key = f"release-maintenance/{record['releaseId']}/{phase}/{job_id}.json"
    metadata = cloud.json(['storage', 'objects', 'describe', f'gs://{bucket}/{key}'])
    if metadata.error or not isinstance(metadata.value, dict) or not str(metadata.value.get('generation', '')).isdigit():
        return metadata if metadata.error else fail('invalid', 'phase receipt generation is unknown')
    generation = str(metadata.value['generation'])
    raw = cloud.bytes(bucket, key, generation)
    if raw.error:
        return raw
    if len(raw.value) > 256 * 1024:
        return fail('invalid', 'phase receipt exceeds private schema limit')
    parsed = parse_json(raw.value)
    if parsed.error:
        return parsed
    validated = validate_envelope(record, parsed.value, phase, job_id)
    if validated.error:
        return validated
    target_bucket = f"pi-orb-tfstate-{record['project']}"
    target = f"static-plane/releases/{record['releaseId']}/maintenance/{tag or phase}.json"
    copied = cloud.copy_bytes(target_bucket, target, raw.value)
    if copied.error:
        return copied
    # Independently retain every per-orb Stop/admission receipt before mutation.
    query = {'prefix': key.removesuffix('.json') + '-', 'maxResults': '1000'}
    seen = set()
    while True:
        listed = cloud.http('GET', f'https://storage.googleapis.com/storage/v1/b/{bucket}/o?' + urllib.parse.urlencode(query))
        if listed.error:
            return listed
        if not isinstance(listed.value, dict) or not isinstance(listed.value.get('items', []), list):
            return fail('invalid', 'private outcome receipt listing is unknown')
        for item in listed.value.get('items', []):
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not item['name'].startswith(query['prefix']) or not isinstance(item.get('generation'), str) or not item['generation'].isdigit():
                return fail('invalid', 'private outcome receipt identity is unknown')
            outcome = cloud.bytes(bucket, item['name'], item['generation'])
            if outcome.error:
                return outcome
            parsed_outcome = parse_json(outcome.value)
            if parsed_outcome.error or len(outcome.value) > 256 * 1024:
                return fail('invalid', 'private outcome receipt is invalid')
            snapshot_phase = 'stop' if phase == 'drain' and '-stop-' in item['name'] else phase
            checked = validate_envelope(record, parsed_outcome.value, phase, job_id, snapshot_phase=snapshot_phase)
            if checked.error:
                return checked
            copied_outcome = cloud.copy_bytes(target_bucket, f"static-plane/releases/{record['releaseId']}/maintenance/outcomes/" + item['name'].rsplit('/', 1)[-1], outcome.value)
            if copied_outcome.error:
                return copied_outcome
        token = listed.value.get('nextPageToken')
        if not token:
            break
        if not isinstance(token, str) or token in seen:
            return fail('invalid', 'private outcome receipt pagination is invalid')
        seen.add(token)
        query['pageToken'] = token
    reference = {'receiptUri': f'gs://{bucket}/{key}', 'generation': generation, 'sha256': hashlib.sha256(raw.value).hexdigest()}
    stored = checkpoint({'phase': phase, 'state': 'sealed', 'job': job, 'reference': reference, 'independentGeneration': copied.value['generation']})
    if stored.error:
        return stored
    deleted = cloud.json(['run', 'jobs', 'delete', job_id, '--project', record['project'], '--region', record['region'], '--quiet'])
    return deleted if deleted.error else Result({'reference': reference, 'snapshot': validated.value})


def main(argv):
    if len(argv) == 3 and argv[1] == 'guard-plan':
        plan = load(argv[2])
        result = plan if plan.error else guard_plan(plan.value)
        if result.error:
            print(f'release: {result.error.kind}: {result.error.message}', file=sys.stderr)
        return 1 if result.error else 0
    if len(argv) != 4 or argv[1] not in ('prepare', 'drain', 'resume', 'migration', 'detect', 'preflight-final', 'outcome'):
        return 2
    loaded = load(argv[2])
    if loaded.error or not validate_record(loaded.value):
        return 1
    record = loaded.value
    cloud = PrivateCloud()
    bucket = f"pi-orb-tfstate-{record['project']}"
    prefix = f"static-plane/releases/{record['releaseId']}/maintenance/"
    def checkpoint(value):
        phase = value.get('phase', 'unknown')
        kind = 'execution' if value.get('state') in ('creating', 'run-requested', 'running', 'terminal') else 'stage'
        return cloud.replace(bucket, prefix + phase + '-' + kind + '.json', value)
    retirement_phase = 'controllers'
    def retirement(value):
        return cloud.replace(bucket, prefix + retirement_phase + '-retirement.json', value['retirement'])
    if argv[1] == 'detect':
        result = detect(cloud, record, argv[3] == 'true')
    elif argv[1] == 'migration':
        job = f"projects/{record['project']}/locations/{record['region']}/jobs/{record['migrationJob']}"
        prior = cloud.http('GET', f'https://run.googleapis.com/v2/{job}/executions?pageSize=1')
        result = prior
        if not result.error and (not isinstance(prior.value, dict) or prior.value.get('executions') or prior.value.get('nextPageToken')):
            result = fail('conflict', 'migration has an existing or unknown execution; never replay')
        if not result.error:
            result = execute(cloud, job, lambda value: cloud.replace(bucket, prefix + 'migration-execution.json', value))
    elif argv[1] == 'prepare':
        config = capture_config(cloud, record)
        result = config
        if not result.error:
            config.value['primaryUserId'] = os.environ.get('PI_ORB_USER_ID', '')
            if not config.value['primaryUserId']:
                result = fail('invalid', 'verified primary user is required')
        if not result.error:
            result = cloud.put(bucket, prefix + 'old-config.json', config.value, '0')
        if not result.error:
            result = run_phase(cloud, record, config.value, 'preflight-before', checkpoint)
        if not result.error:
            issuer = copy.deepcopy(record)
            result = inventory(cloud, issuer, services=('pi-orb-issuer',))
            if not result.error:
                result = cloud.put(bucket, prefix + 'issuer-retirement.json', issuer['retirement'], '0')
        if not result.error:
            result = run_phase(cloud, record, config.value, 'before', checkpoint)
        if not result.error:
            provider = provider_inventory(cloud, record, {o['id'] for o in result.value['snapshot']['orbs']})
            result = provider if provider.error else cloud.put(bucket, prefix + 'provider-before.json', provider.value, '0')
        if not result.error:
            result = save(argv[3], {'config': config.value})
    else:
        context = load(argv[3])
        result = context
        if not result.error:
            config = context.value['config']
            if argv[1] == 'outcome':
                result = run_phase(cloud, record, config, 'before', checkpoint, tag='outcome')
                if not result.error:
                    snapshot = result.value['snapshot']
                    provider = provider_inventory(cloud, record, {o['id'] for o in snapshot['orbs']})
                    result = provider
                    if not result.error:
                        result = verify_workspaces(context.value['providerFinal'], provider.value, snapshot)
                    if not result.error:
                        admitted = {o['id']: o for o in context.value['admitted']['orbs']}
                        for orb in snapshot['orbs']:
                            previous = admitted.get(orb['id'])
                            if previous and previous['state'] == 'creating' and orb['stateVersion'] == previous['stateVersion'] and orb['state'] == 'creating':
                                result = fail('conflict', 'admitted fleet intent has not progressed after activation')
                                break
                    if not result.error:
                        result = cloud.put(bucket, prefix + 'provider-outcome.json', provider.value, '0')
            elif argv[1] == 'preflight-final':
                for name, services in (('controllers', ('pi-orb', 'pi-orb-ops')), ('broker', ('pi-orb-runtime-api',))):
                    observed = cloud.object(bucket, prefix + name + '-retirement.json')
                    result = observed
                    if result.error or observed.value is None:
                        result = observed if observed.error else fail('invalid', 'legacy retirement receipt is missing')
                        break
                    candidate = copy.deepcopy(record)
                    candidate['retirement'] = observed.value['body']
                    result = wait_for_retirement(cloud, candidate, services=services, limit=0)
                    if result.error:
                        break
                if not result.error:
                    result = run_phase(cloud, record, config, 'preflight-final', checkpoint)
            elif argv[1] == 'drain':
                result = fence(cloud, record, ('pi-orb', 'pi-orb-ops'), retirement)
                if not result.error:
                    result = run_phase(cloud, record, config, 'drain', checkpoint)
                if not result.error:
                    baseline = result.value['reference']
                    retirement_phase = 'broker'
                    result = fence(cloud, record, ('pi-orb-runtime-api',), retirement)
                if not result.error:
                    result = run_phase(cloud, record, config, 'final', checkpoint, baseline)
                if not result.error:
                    context.value['final'] = result.value['reference']
                    provider = provider_inventory(cloud, record, {o['id'] for o in result.value['snapshot']['orbs']}, require_stopped=True)
                    if not provider.error:
                        context.value['providerFinal'] = provider.value
                    result = provider if provider.error else cloud.put(bucket, prefix + 'provider-final.json', provider.value, '0')
                if not result.error:
                    result = save(argv[3], context.value)
                if not result.error:
                    issuer = cloud.object(bucket, prefix + 'issuer-retirement.json')
                    result = issuer
                    if not result.error:
                        record['retirement'] = issuer.value['body']
                        result = save(argv[2], record)
                        if not result.error:
                            result = publish(cloud, record)
            else:
                services = cloud.json(['run', 'services', 'list', '--project', record['project'], '--region', record['region']])
                result = services
                if not result.error and (not isinstance(services.value, list) or any(not isinstance(s, dict) or not isinstance(s.get('metadata'), dict) for s in services.value) or any(s['metadata'].get('name') in OLD for s in services.value)):
                    result = fail('conflict', 'legacy writers remain or are unknown before resume admission')
                if not result.error:
                    issuer = cloud.json(['run', 'services', 'describe', 'pi-orb-issuer', '--project', record['project'], '--region', record['region']])
                    result = issuer
                    if not result.error and (not isinstance(issuer.value, dict) or issuer.value.get('status', {}).get('latestReadyRevisionName') not in record['retirement']['revisions']):
                        result = fail('conflict', 'candidate exposure closure is not proven')
                if not result.error:
                    active = cloud.object(bucket, 'static-plane/releases/active.json')
                    result = active
                    if not result.error and (not isinstance(active.value, dict) or active.value.get('generation') != config['activeGeneration']):
                        result = fail('conflict', 'old active authority changed before admission')
                if not result.error:
                    result = run_phase(cloud, record, config, 'preapply-resume', checkpoint, context.value['final'])
                    if not result.error:
                        context.value['admitted'] = result.value['snapshot']
                        result = save(argv[3], context.value)
    if result.error:
        print(f'release: {result.error.kind}: {result.error.message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
