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


def main(args):
    if len(args) != 1 or not args[0]:
        print("usage: python3 -m infra.release_preflight PROJECT", file=sys.stderr)
        return 2
    result = check_exclusion_authority(Cloud(), args[0])
    if result.error:
        print("release preflight failed: " + result.error.message, file=sys.stderr)
        return 1
    print("release preflight: logging exclusion authority verified")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
