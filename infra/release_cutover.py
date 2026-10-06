"""Actions-owned retirement of the three former application services."""
import sys
import time
import urllib.parse
from infra.release_state import Cloud, Result, fail, load, now, save, publish, validate_record
from infra.release_retire import inventory, wait_for_retirement

OLD_SERVICES = ('pi-orb', 'pi-orb-ops', 'pi-orb-runtime-api')


def retire(cloud, record, checkpoint, wall=now, monotonic=time.monotonic, sleep=time.sleep):
    root = f"https://run.googleapis.com/v2/projects/{record['project']}/locations/{record['region']}"
    identities = {}
    for name in (*OLD_SERVICES, 'pi-orb-issuer'):
        found = cloud.http('GET', root + '/services/' + name)
        if found.error:
            return found
        if found.value is not None and (not isinstance(found.value, dict) or found.value.get('name') != root.split('/v2/')[1] + '/services/' + name or not all(isinstance(found.value.get(key), str) and found.value[key] for key in ('uid', 'etag'))):
            return fail('invalid', 'invalid v2 service identity')
        identities[name] = found.value
    if identities['pi-orb-issuer'] is None:
        return fail('conflict', 'the existing issuer must remain in place')
    present = [name for name in OLD_SERVICES if identities[name] is not None]
    if present and len(present) != len(OLD_SERVICES):
        return fail('conflict', 'partial old-service fence requires operator review')
    for name in present:
        allowed = cloud.http('POST', root + '/services/' + name + ':testIamPermissions', {'permissions': ['run.services.delete']})
        if allowed.error:
            return allowed
        if not isinstance(allowed.value, dict) or 'run.services.delete' not in allowed.value.get('permissions', []):
            return fail('conflict', 'missing old-service deletion permission')
    found = inventory(cloud, record, services=OLD_SERVICES)
    if found.error:
        return found
    stored = checkpoint(record)
    if stored.error:
        return stored
    for name in present:
        url = root + '/services/' + name
        current = cloud.http('GET', url)
        if current.error:
            return current
        if not isinstance(current.value, dict) or any(current.value.get(key) != identities[name][key] for key in ('name', 'uid', 'etag')):
            return fail('conflict', 'old service changed before retirement')
        deleted = cloud.http('DELETE', url + '?' + urllib.parse.urlencode({'etag': identities[name]['etag']}))
        if deleted.error:
            return deleted
        operation = deleted.value
        expected = root.split('/v2/')[1] + '/operations/'
        if not isinstance(operation, dict) or not isinstance(operation.get('name'), str) or not operation['name'].startswith(expected) or '/' in operation['name'][len(expected):] or not operation['name'][len(expected):]:
            return fail('invalid', 'invalid service deletion operation')
        deadline = monotonic() + 300
        while operation.get('done') is not True:
            if monotonic() >= deadline:
                return fail('timeout', 'service deletion remains uncertain')
            sleep(2)
            observed = cloud.http('GET', 'https://run.googleapis.com/v2/' + operation['name'])
            if observed.error:
                return observed
            if not isinstance(observed.value, dict) or observed.value.get('name') != operation['name']:
                return fail('invalid', 'missing or changed service deletion operation')
            operation = observed.value
        if 'error' in operation:
            return fail('http', 'service deletion failed')
        print('release: retired service ' + name, flush=True)
        stored = checkpoint(record)
        if stored.error:
            return stored
    for name in OLD_SERVICES:
        found = cloud.http('GET', root + '/services/' + name)
        if found.error:
            return found
        if found.value is not None:
            return fail('conflict', 'old service can still reactivate')
    record['retirement']['after'] = wall()
    record['retirement']['zeroes'] = {}
    stored = checkpoint(record)
    if stored.error:
        return stored
    return wait_for_retirement(cloud, record, checkpoint=checkpoint, services=OLD_SERVICES)


def main(argv):
    if len(argv) != 2:
        print('usage: release_cutover RECORD', file=sys.stderr)
        return 2
    loaded = load(argv[1])
    if loaded.error or not validate_record(loaded.value):
        print('release: invalid cutover record', file=sys.stderr)
        return 1
    cloud = Cloud()
    def checkpoint(record):
        stored = save(argv[1], record)
        return stored if stored.error else publish(cloud, record)
    result = retire(cloud, loaded.value, checkpoint)
    if not result.error:
        # Capture the prior issuer revisions for the normal post-apply gate.
        result = inventory(cloud, loaded.value)
        if not result.error:
            result = checkpoint(loaded.value)
    if result.error:
        print(f'release: {result.error.kind}: {result.error.message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
