"""Read-only release authority checks; never print tokens or remote bodies."""
import sys
import urllib.parse

from infra.release_state import Cloud, Result, fail


EXCLUSION_PERMISSIONS = (
    "logging.exclusions.create",
    "logging.exclusions.get",
    "logging.exclusions.update",
    "logging.exclusions.delete",
)


def check_exclusion_authority(cloud, project):
    result = cloud.http(
        "POST",
        "https://cloudresourcemanager.googleapis.com/v1/projects/"
        + urllib.parse.quote(project, safe="") + ":testIamPermissions",
        {"permissions": list(EXCLUSION_PERMISSIONS)},
    )
    if result.error:
        return result
    body = result.value
    if not isinstance(body, dict):
        return fail("invalid", "invalid exclusion authority response")
    permissions = body.get("permissions", [])
    if not isinstance(permissions, list) or not all(isinstance(p, str) for p in permissions):
        return fail("invalid", "invalid exclusion authority permissions")
    missing = sorted(set(EXCLUSION_PERMISSIONS) - set(permissions))
    if missing:
        return fail("invalid", "missing release permissions: " + ", ".join(missing)
                    + "; a foundation administrator must apply infra/foundation first")
    return Result(True)


def check_consolidation_authority(cloud, project, account):
    project = urllib.parse.quote(project, safe='')
    probes = (
        (f'https://cloudresourcemanager.googleapis.com/v1/projects/{project}:testIamPermissions',
         ['run.jobs.create', 'run.jobs.run', 'run.jobs.get', 'run.jobs.delete', 'run.services.delete']),
        (f'https://secretmanager.googleapis.com/v1/projects/{project}/secrets/pi-orb-google-identity-mappings:testIamPermissions',
         ['secretmanager.secrets.getIamPolicy', 'secretmanager.secrets.setIamPolicy']),
        (f'https://iam.googleapis.com/v1/projects/-/serviceAccounts/{urllib.parse.quote(account, safe="")}:testIamPermissions',
         ['iam.serviceAccounts.actAs']),
    )
    for url, required in probes:
        found = cloud.http('POST', url, {'permissions': required})
        if found.error:
            return found
        if not isinstance(found.value, dict) or not isinstance(found.value.get('permissions'), list):
            return fail('invalid', 'consolidation capability response is unknown')
        if any(not isinstance(p, str) for p in found.value['permissions']):
            return fail('invalid', 'consolidation capability permissions are unknown')
        missing = sorted(set(required) - set(found.value['permissions']))
        if missing:
            return fail('conflict', 'missing consolidation permissions: ' + ', '.join(missing))
    return Result()


def main(args):
    if len(args) not in (1, 2) or not args[0]:
        print("usage: python3 -m infra.release_preflight PROJECT", file=sys.stderr)
        return 2
    cloud = Cloud()
    result = check_exclusion_authority(cloud, args[0])
    if not result.error and len(args) == 2:
        result = check_consolidation_authority(cloud, args[0], args[1])
    if result.error:
        print("release preflight failed: " + result.error.message, file=sys.stderr)
        return 1
    print("release preflight: logging exclusion authority verified")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
