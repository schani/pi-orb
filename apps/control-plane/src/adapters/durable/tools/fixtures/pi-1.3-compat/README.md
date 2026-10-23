# Pi 1.3 native persistence fixtures

Synthetic data generated with the clean, qualified installation at
`3ce807c7d27cec1661a758df084e35266c5b3cd1`. No provider calls, credentials,
or private prompts.

- `completed.json`: native result and store committed; outer tool has not returned.
- `interrupted-{safe,unsafe}.json`: completed nested receipt followed by a running
  callback. Captured at callback entry, before graceful close; no shutdown writes.
- `store.json`: old conversation, agent and store revisions with markers at
  counters 0 and 2. A failed old execution leaves the successful values unchanged.
  Current native commits exercise the 64-delta checkpoint boundary in the test.

Capture uses the old Storage port; retained records are unchanged. Task/submission
rows keep only their final version. Current-only documents retain their creation,
last native base and following deltas; rewindable revisions stay intact. Empty
batches preserve commit sequences. Generation checks restored current documents,
delta counts, tasks, submissions and store history against the original storage.
Interrupted cuts use only the three tested callbacks; safe/unsafe captures remain
separate. Tests use the production adapter and VM, not a live old/new handshake or
PG schema migration.

`provenance.json` records source/package versions, four patch hashes, all 18
installed patched-file seals, generator/fixture hashes, fixed clock and seed.
Generation verifies installed seals against the old installer and requires a
clean old checkout. The old installation’s Biome and configuration format each
JSON file before fixture hashes are computed. Earlier clean installation evidence:
`/tmp/dependency-integration-evidence/final-main/ci.log`, `ci.exit=0`
(Node 24.22.1, npm 11.19.1).

## Regenerate

Keep the old checkout and its installed dependencies unchanged. Run a temporary
copy so package resolution uses the old installation:

```sh
export PATH=/path/to/node-v24.22.1-linux-x64/bin:$PATH
old=/workspace/dependency-prs/final-qualified
fixtures=/workspace/dependency-prs/pi-update-main-integration/apps/control-plane/src/adapters/durable/tools/fixtures/pi-1.3-compat
tmp=$(mktemp -d /tmp/pi13-generator.XXXXXX)
ln -s "$old/node_modules" "$tmp/node_modules"
cp "$fixtures/generate.ts" "$tmp/generate.test.ts"
printf 'export default {test:{include:[%s],maxWorkers:1}};\n' \
  "\"$tmp/generate.test.ts\"" > "$tmp/vitest.config.mjs"
flock /tmp/pi-orb-dependency-heavy-check.lock env \
  PI13_BASELINE="$old" PI13_OUTPUT="$fixtures" \
  "$old/node_modules/.bin/vitest" run --config "$tmp/vitest.config.mjs"
```

Only successful callback-entry signals advance the crash snapshots. Clock and
seed are fixed; resource-accounting measurements are not byte-deterministic.
