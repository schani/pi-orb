#!/usr/bin/env bash
# Build an immutable install artifact; never downloads or patches packages at runtime.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
fork=${1:?usage: build-fork.sh /path/to/pi-packages}
expected=6d333b00670d778812b79bce2dd2e1db3f5f9692
[[ $(git -C "$fork" rev-parse HEAD) == "$expected" ]]
git -C "$fork" diff --exit-code HEAD -- packages/pi-subagents
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/package/dist" "$repo/vendor"
git -C "$fork" archive HEAD packages/pi-subagents | tar -x -C "$stage"
cp -R "$stage/packages/pi-subagents/src" "$stage/package/"
cp "$stage/packages/pi-subagents/"{package.json,README.md,LICENSE} "$stage/package/"
cp "$repo/scripts/subagent-liveness/node_modules/@gotgenes/pi-subagents/dist/public.d.ts" "$stage/package/dist/"
"$repo/node_modules/.bin/esbuild" "$fork/packages/pi-subagents/src/index.ts" \
  --bundle --platform=node --format=esm --packages=external \
  --alias:@sinclair/typebox=typebox --outfile="$stage/package/dist/extension.js"
"$repo/node_modules/.bin/esbuild" "$fork/packages/pi-subagents/src/service/service.ts" \
  --bundle --platform=node --format=esm --packages=external \
  --outfile="$stage/package/dist/service.js"
python3 - "$stage/package" "$expected" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); x=json.loads((p/'package.json').read_text())
x['version']='21.7.0-orb.4'
x['exports']['.']['default']='./dist/service.js'
x['exports']['./extension']={'types':'./dist/extension.d.ts','default':'./dist/extension.js'}
x['pi']['extensions']=['./dist/extension.js']
x['files']=['src','dist','README.md','LICENSE','FORK.json']
x.pop('devDependencies',None);x.pop('scripts',None)
(p/'package.json').write_text(json.dumps(x,indent=2)+'\n')
(p/'FORK.json').write_text(json.dumps({'upstream':'https://github.com/gotgenes/pi-packages','base':'b3b6159399f541fd0623f65818557dd3e707a34f','commit':sys.argv[2],'esbuild':'0.28.1'},indent=2)+'\n')
(p/'dist/extension.d.ts').write_text('import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";\nexport interface SubagentsHostOptions { shouldWake?: (record: { readonly id: string }) => boolean; childExtensions?: InlineExtension[]; cwd?: string; }\nexport default function subagents(pi: ExtensionAPI, host?: SubagentsHostOptions): void;\n')
PY
(cd "$stage/package" && npm pack --ignore-scripts --pack-destination "$repo/vendor")
