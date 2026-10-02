#!/usr/bin/env python3
"""Build a contained, checksum-indexed SDK qualification source archive."""
import hashlib
import io
import json
import pathlib
import tarfile
import sys

root = pathlib.Path(__file__).resolve().parents[3]
output = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else None
if output is None or output.is_relative_to(root):
    raise SystemExit('provide an archive path outside the checkout')
files = ['package.json', 'package-lock.json', 'tsconfig.base.json',
         'scripts/fix-node-pty-prebuild-permissions.mjs']
for directory in ['apps', 'packages', 'patches', 'vendor',
                  'scripts/native-mcp-exploration/live-qualification']:
    files.extend(str(path.relative_to(root)) for path in (root / directory).rglob('*')
                 if path.is_file() and not path.is_symlink() and not any(
                     segment in {'node_modules', 'dist', '.git', '.context', 'test-failures', '__pycache__'}
                     for segment in path.relative_to(root).parts))
files = sorted(set(files))
manifest = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
output.parent.mkdir(parents=True, exist_ok=True)
with tarfile.open(output, 'w:gz') as archive:
    for name in files:
        data = (root / name).read_bytes()
        member = tarfile.TarInfo(name)
        member.size = len(data)
        member.mode = 0o644
        archive.addfile(member, io.BytesIO(data))
    data = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    member = tarfile.TarInfo('owned-context-manifest.json')
    member.size = len(data)
    member.mode = 0o644
    archive.addfile(member, io.BytesIO(data))
print(json.dumps({'archiveSha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'fileCount': len(files)}))
