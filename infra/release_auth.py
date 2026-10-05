"""Verify existing authentication metadata without reading secret payloads."""
import re
import sys
from infra.release_state import Cloud, Result, fail


def verify(cloud, project):
    email = f'pi-orb-debug@{project}.iam.gserviceaccount.com'
    account = cloud.json(['iam', 'service-accounts', 'describe', email, f'--project={project}'])
    if account.error:
        return account
    value = account.value
    if not isinstance(value, dict) or value.get('email') != email or value.get('disabled', False) is not False or not isinstance(value.get('uniqueId'), str) or re.fullmatch(r'[0-9]{10,32}', value['uniqueId']) is None:
        return fail('invalid', 'existing debug service account identity is invalid')
    for secret in ('pi-orb-google-client-secret', 'pi-orb-cookie-secret'):
        version = cloud.json(['secrets', 'versions', 'describe', '1', f'--secret={secret}', f'--project={project}'])
        if version.error:
            return version
        metadata = version.value
        if not isinstance(metadata, dict) or metadata.get('state') != 'ENABLED' or not isinstance(metadata.get('name'), str) or re.fullmatch(rf'projects/[0-9]+/secrets/{secret}/versions/1', metadata['name']) is None:
            return fail('invalid', 'pinned authentication secret version is not enabled')
    return Result(value['uniqueId'])


def main(argv):
    if len(argv) != 2:
        print('usage: release_auth PROJECT', file=sys.stderr)
        return 2
    result = verify(Cloud(), argv[1])
    if result.error:
        print(f'release: {result.error.kind}: {result.error.message}', file=sys.stderr)
        return 1
    print(result.value)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
