#!/usr/bin/env python3
"""Rebuild/verify the Pi 0.99.1 tarball with only the nested brace fix.

Usage: python3 scripts/verify-pi-brace-tarball.py VERSION UPSTREAM_TARBALL
The upstream archive must be obtained from npm (npm pack @earendil-works/pi-coding-agent@VERSION).
"""
import base64
import copy
import gzip
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

VERSIONS = {
    "0.99.1": "sha512-cWUrTOqA5M73cOYMgsh9PlhDrsBhavd+n5kVY6F7BGbGl1RjqCteVCoeVMVqhngoGACVDyw1tbLjajL8l9jrHg==",
}
BRACE = {
    "version": "5.0.12",
    "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
    "integrity": "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==",
}
OLD = {
    "version": "5.0.9",
    "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz",
    "integrity": "sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==",
}


def integrity(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def main(version, upstream_path):
    upstream = Path(upstream_path).read_bytes()
    assert integrity(upstream) == VERSIONS[version], "upstream tarball integrity mismatch"
    target = Path(f"vendor/pi-coding-agent-{version}-brace-5.0.12.tgz")
    with tarfile.open(fileobj=io.BytesIO(upstream), mode="r:gz") as archive:
        members = archive.getmembers()
        contents = {member.name: archive.extractfile(member).read() for member in members if member.isfile()}
    key = "package/npm-shrinkwrap.json"
    before = json.loads(contents[key])
    packages = before["packages"]
    assert packages["node_modules/@earendil-works/pi-ai"]["dependencies"]["http-proxy-agent"] == "9.1.0"
    assert packages["node_modules/http-proxy-agent"]["version"] == "9.1.0"
    assert packages["node_modules/https-proxy-agent"]["version"] == "7.0.6"
    assert before["packages"]["node_modules/brace-expansion"] == {
        **OLD,
        "license": "MIT",
        "dependencies": {"balanced-match": "^4.0.2"},
        "engines": {"node": "20 || >=22"},
    }, "unexpected upstream shrinkwrap entry"
    after = contents[key]
    begin = after.index(b'"node_modules/brace-expansion": {')
    end = after.index(b'"license": "MIT"', begin)
    entry = after[begin:end]
    for field in ("version", "resolved", "integrity"):
        old = f'"{field}": "{OLD[field]}"'.encode()
        new = f'"{field}": "{BRACE[field]}"'.encode()
        assert entry.count(old) == 1, (version, field)
        entry = entry.replace(old, new)
    after = after[:begin] + entry + after[end:]
    contents[key] = after
    assert json.loads(after)["packages"]["node_modules/brace-expansion"] == {
        **before["packages"]["node_modules/brace-expansion"], **BRACE
    }
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for member in members:
                entry = copy.copy(member)
                if member.isfile():
                    entry.size = len(contents[member.name])
                archive.addfile(entry, io.BytesIO(contents[member.name]) if member.isfile() else None)
    result = output.getvalue()
    if len(sys.argv) == 4 and sys.argv[3] == "--write":
        target.write_bytes(result)
    assert target.read_bytes() == result, "vendor archive differs from reproducible upstream rebuild"
    with tarfile.open(fileobj=io.BytesIO(result), mode="r:gz") as archive:
        repacked = {member.name: archive.extractfile(member).read() for member in archive if member.isfile()}
    assert set(repacked) == set(contents)
    assert all(repacked[name] == data for name, data in contents.items()), "unexpected file changes"
    js = [name for name in contents if name.endswith((".js", ".mjs", ".cjs"))]
    assert all(repacked[name] == contents[name] for name in js), "SDK JavaScript changed"
    assert len(js) == 315, "unexpected SDK JavaScript inventory"
    print(f"{version}: upstream {integrity(upstream)}; vendor {integrity(result)}; only {key} brace entry changed; {len(js)} SDK JavaScript files unchanged; Pi AI proxy 9.1.0")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4) or sys.argv[1] not in VERSIONS or (len(sys.argv) == 4 and sys.argv[3] != "--write"):
        sys.exit("usage: verify-pi-brace-tarball.py VERSION UPSTREAM_TARBALL [--write]")
    main(sys.argv[1], sys.argv[2])
