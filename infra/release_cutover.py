"""Explicit first-cutover evidence gate. Does not stop services or migrate data."""
import copy
import sys
import re
from infra.release_state import Cloud, Result, fail, load, now, save, publish, validate_record
from infra.release_retire import inventory, wait_for_retirement

OLD_SERVICES = ('pi-orb', 'pi-orb-ops', 'pi-orb-runtime-api')


def verify(cloud, record, manifest):
    fields = {'project', 'region', 'commit', 'recoveryPoint', 'restorationIdentity', 'fleetStopped', 'wakeIntentsReviewed', 'retirement'}
    if not isinstance(manifest, dict) or set(manifest) != fields:
        return fail('invalid', 'invalid maintenance manifest')
    if any(manifest[key] != record[key] for key in ('project', 'region', 'commit')):
        return fail('conflict', 'maintenance target differs from release')
    if any(manifest[key] is not True for key in ('fleetStopped', 'wakeIntentsReviewed')) or any(not isinstance(manifest[key], str) or re.fullmatch(r'[A-Za-z0-9/_.:@-]{1,256}', manifest[key]) is None for key in ('recoveryPoint', 'restorationIdentity')):
        return fail('invalid', 'fleet, wake intents and independent recovery require review')
    candidate = copy.deepcopy(record)
    candidate['retirement'] = copy.deepcopy(manifest['retirement'])
    if not validate_record(candidate):
        return fail('invalid', 'invalid maintenance retirement evidence')
    proof = candidate['retirement']
    if proof is None or not proof['revisions'] or proof['operations'] or set(proof['revisions']) != set(proof['zeroes']):
        return fail('invalid', 'explicit zero-container and completed-operation proof required')
    fenced = check_fenced_services(cloud, record)
    return fenced if fenced.error else Result(candidate)


def check_fenced_services(cloud, record):
    services = cloud.json(['run', 'services', 'list', '--project', record['project'], '--region', record['region']])
    if services.error:
        return services
    if not isinstance(services.value, list) or any(not isinstance(item, dict) or not isinstance(item.get('metadata'), dict) or not isinstance(item['metadata'].get('name'), str) for item in services.value):
        return fail('invalid', 'invalid service inventory')
    if any(item['metadata']['name'] in OLD_SERVICES for item in services.value):
        return fail('conflict', 'old identity writers can still reactivate; retire every old service first')
    if sum(item['metadata']['name'] == 'pi-orb-issuer' for item in services.value) != 1:
        return fail('conflict', 'the existing issuer service must remain in place')
    return Result()


def begin_observation(cloud, record, manifest, wall=now):
    candidate = copy.deepcopy(record)
    candidate['retirement'] = copy.deepcopy(manifest.get('retirement')) if isinstance(manifest, dict) else None
    if not validate_record(candidate) or not candidate['retirement']:
        return fail('invalid', 'invalid inventory')
    fenced = check_fenced_services(cloud, candidate)
    if fenced.error:
        return fenced
    candidate['retirement']['after'] = wall()
    candidate['retirement']['zeroes'] = {}
    return Result(candidate) if validate_record(candidate) else fail('invalid', 'invalid fence clock')


def main(argv):
    if len(argv) != 4 or argv[1] not in ('inventory', 'observe', 'verify'):
        print('usage: release_cutover <inventory|observe|verify> RECORD MANIFEST', file=sys.stderr)
        return 2
    record = load(argv[2])
    manifest = Result(None) if argv[1] == 'inventory' else load(argv[3])
    if record.error or manifest.error or not validate_record(record.value):
        print('release: invalid cutover input', file=sys.stderr)
        return 1
    cloud = Cloud()
    if argv[1] == 'inventory':
        result = inventory(cloud, record.value, services=OLD_SERVICES)
        if not result.error:
            value = {key: record.value[key] for key in ('project', 'region', 'commit')}
            value.update(recoveryPoint='', restorationIdentity='', fleetStopped=False, wakeIntentsReviewed=False, retirement=result.value['retirement'])
            result = save(argv[3], value)
        if result.error:
            print(f'release: {result.error.kind}: {result.error.message}', file=sys.stderr)
            return 1
        return 0
    if argv[1] == 'observe':
        result = begin_observation(cloud, record.value, manifest.value)
        if not result.error:
            manifest.value['retirement'] = result.value['retirement']
            stored = save(argv[3], manifest.value)
            if stored.error:
                result = stored
    else:
        result = verify(cloud, record.value, manifest.value)
    if not result.error:
        # Recheck Monitoring: a later positive sample invalidates stored zeroes.
        candidate = result.value
        issuer = cloud.json(['run', 'services', 'describe', 'pi-orb-issuer', '--project', candidate['project'], '--region', candidate['region']])
        status = issuer.value.get('status') if not issuer.error and isinstance(issuer.value, dict) else None
        revision = status.get('latestReadyRevisionName') if isinstance(status, dict) else None
        if not isinstance(revision, str):
            result = fail('invalid', 'surviving issuer revision is unknown')
        else:
            serving = candidate['serving']
            candidate['serving'] = [{'service': 'pi-orb-issuer', 'revision': revision}]
            def checkpoint(value):
                if argv[1] != 'observe':
                    return Result()
                manifest.value['retirement'] = value['retirement']
                return save(argv[3], manifest.value)
            result = wait_for_retirement(cloud, candidate, checkpoint=checkpoint, limit=75 * 60 if argv[1] == 'observe' else 0)
            candidate['serving'] = serving
            if argv[1] == 'observe':
                manifest.value['retirement'] = candidate['retirement']
                stored = save(argv[3], manifest.value)
                if stored.error:
                    result = stored
                if not result.error:
                    return 0
            elif not result.error:
                candidate['retirement']['revisions'] = sorted(set(candidate['retirement']['revisions']) | {revision})
    if not result.error:
        result = cloud.put(f"pi-orb-tfstate-{candidate['project']}", f"static-plane/releases/{candidate['releaseId']}-maintenance.json", manifest.value, '0')
    if not result.error:
        result = save(argv[2], candidate)
    if not result.error:
        result = publish(cloud, candidate)
    if result.error:
        print(f'release: {result.error.kind}: {result.error.message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
