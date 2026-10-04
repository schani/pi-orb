#!/usr/bin/env python3
"""Reproduce the patch-package fork from integrity-checked npm archives.

Usage: verify-patch-package-tarball.py PATCH_TARBALL FINDER_TARBALL MICROMATCH_TARBALL [--write]
"""
import base64
import copy
import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

PATCH_INTEGRITY = "sha512-VsKRIA8f5uqHQ7NGhwIna6Bx6D9s/1iXlA1hthBVBEbkq+t4kXD0HHt+rJhf/Z+Ci0F/HCB2hvn0qLdLG+Qxlw=="
FINDER_INTEGRITY = "sha512-1IMnbjt4KzsQfnhnzNd8wUEgXZ44IzZaZmnLYx7D5FZlaHt2gW20Cri8Q+E/t5tIj4+epTBub+2Zxu/vNILzqQ=="
MICROMATCH_INTEGRITY = "sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA=="
ROOT = Path(__file__).resolve().parent.parent


def integrity(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def unpack(path, expected):
    data = Path(path).read_bytes()
    assert integrity(data) == expected, f"upstream integrity mismatch: {path}"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        contents = {m.name: archive.extractfile(m).read() for m in members if m.isfile()}
    return members, contents


def main(patch_path, finder_path, micromatch_path, write):
    members, contents = unpack(patch_path, PATCH_INTEGRITY)
    _, finder = unpack(finder_path, FINDER_INTEGRITY)
    _, micromatch = unpack(micromatch_path, MICROMATCH_INTEGRITY)
    before = dict(contents)
    manifest = json.loads(contents["package/package.json"])
    assert manifest["name"] == "patch-package" and manifest["version"] == "8.0.1"
    assert manifest["dependencies"].pop("find-yarn-workspace-root") == "^2.0.0"
    manifest["version"] = "8.0.1-orb.1"
    manifest["dependencies"]["picomatch"] = "2.3.2"
    manifest["license"] = "(MIT AND Apache-2.0)"
    contents["package/package.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    for name in ("detectPackageManager", "getPackageResolution"):
        key = f"package/dist/{name}.js"
        old = b'require("find-yarn-workspace-root")'
        assert contents[key].count(old) == 1
        contents[key] = contents[key].replace(old, b'require("./findWorkspaceRoot")')
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "index.js"
        source.write_bytes(finder["package/index.js"])
        subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-i", str(ROOT / "scripts/vendor/find-yarn-workspace-root.patch")], cwd=directory, check=True)
        contents["package/dist/findWorkspaceRoot.js"] = source.read_bytes()
    upstream_source = micromatch["package/index.js"].decode()
    start = upstream_source.index("const micromatch = (list, patterns, options) => {")
    end = upstream_source.index("\n};", start) + len("\n};")
    matcher = upstream_source[start:end].replace("const micromatch =", "const matchWorkspaces =", 1)
    expected_finder = finder["package/index.js"].decode().replace(
        "'use strict';\n\n",
        "'use strict';\n\n// Modified by pi-orb: replace micromatch with its primary matcher using picomatch.\n\n",
        1,
    ).replace(
        "const micromatch = require('micromatch');", "const picomatch = require('picomatch');"
    ).replace(
        "module.exports = findWorkspaceRoot;",
        "// Matching implementation from micromatch 4.0.8 (MICROMATCH-LICENSE).\n" + matcher + "\n\nmodule.exports = findWorkspaceRoot;"
    ).replace("micromatch([relativePath], workspaces)", "matchWorkspaces([relativePath], workspaces)")
    assert contents["package/dist/findWorkspaceRoot.js"].decode() == expected_finder, "discovery or matching differs from upstream"
    contents["package/MICROMATCH-LICENSE"] = micromatch["package/LICENSE"]
    contents["package/FIND-YARN-WORKSPACE-ROOT-LICENSE"] = finder["package/LICENSE"]
    changed = {name for name in before if before[name] != contents[name]}
    assert changed == {"package/package.json", "package/dist/detectPackageManager.js", "package/dist/getPackageResolution.js"}
    for name in sorted(set(contents) - set(before)):
        entry = tarfile.TarInfo(name)
        entry.mode = 0o644
        members.append(entry)
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for member in members:
                entry = copy.copy(member)
                if member.isfile():
                    entry.size = len(contents[member.name])
                archive.addfile(entry, io.BytesIO(contents[member.name]) if member.isfile() else None)
    result = output.getvalue()
    target = ROOT / "vendor/patch-package-8.0.1-orb.1.tgz"
    if write:
        target.write_bytes(result)
    assert target.read_bytes() == result, "vendor differs from reproducible rebuild"
    print(f"patch-package 8.0.1-orb.1: {integrity(result)}; embedded finder 2.0.0 and exact micromatch 4.0.8 matcher; picomatch 2.3.2")


if __name__ == "__main__":
    if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[4] != "--write"):
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3], len(sys.argv) == 5)
