#!/usr/bin/env python3
"""Reject tracked state, plans and generated credentials without printing content."""
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile


def inspect(path: Path) -> str | None:
    if re.search(r"\.(?:tfstate|tfplan|plan)(?:\.|$)", path.name) or (
        path.name.startswith("gha-creds-") and path.suffix == ".json"
    ) or ".terraform" in path.parts:
        return "forbidden artifact name"
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                if {"tfplan", "tfstate", "tfstate-prev"} & {Path(name).name for name in archive.namelist()}:
                    return "OpenTofu plan archive"
        try:
            value = json.loads(path.read_bytes())
        except (ValueError, UnicodeError):
            return None
        if isinstance(value, dict):
            if value.get("type") in ("authorized_user", "service_account") and ("refresh_token" in value or "private_key" in value):
                return "Google credential material"
            source = value.get("credential_source")
            if value.get("type") == "external_account" and isinstance(source, dict):
                headers = source.get("headers")
                if isinstance(headers, dict) and any(key.lower() == "authorization" for key in headers):
                    return "bearer-bearing external-account configuration"
        if isinstance(value, dict) and "terraform_version" in value and (
            {"resources", "values", "planned_values", "resource_changes"} & value.keys()
        ):
            return "OpenTofu state or plan JSON"
    except (OSError, zipfile.BadZipFile):
        return "cannot inspect tracked file"
    return None


def main() -> int:
    try:
        result = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=False)
    except OSError:
        print("artifact guard: cannot execute git", file=sys.stderr)
        return 1
    if result.returncode:
        print("artifact guard: cannot inventory tracked files", file=sys.stderr)
        return 1
    blocked = []
    for raw in result.stdout.split(b"\0"):
        if raw:
            path = Path(raw.decode("utf-8", errors="surrogateescape"))
            reason = inspect(path)
            if reason:
                blocked.append((str(path), reason))
    for path, reason in blocked:
        print(f"artifact guard: {json.dumps(path)}: {reason}", file=sys.stderr)
    return int(bool(blocked))


if __name__ == "__main__":
    sys.exit(main())
