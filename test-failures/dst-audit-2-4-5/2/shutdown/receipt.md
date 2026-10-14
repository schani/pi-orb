# Audit #2 — safe-boundary shutdown

2026-10-14, America/Los_Angeles. Local, undeployed. Corrected sources are frozen (`frozen-sha256.txt`). **76 focused tests pass**; full normal-suite and runtime E2E validation are running, with the final gate pending. Original receipt: `.context/dst-audit/2-shutdown/receipt.md`; provenance: `../../MANIFEST.md`.

## Red and explicit pre-fix replay

All three red runs and six explicit replays exited 1 before the product fix. Scenarios below are byte-identical snapshots outside test discovery.

| Stage / scenario | Shutdown trace | Fatal trace | Failure |
| --- | --- | --- | --- |
| Fixture: `fixture-red.test.ts.txt` | `poll-catchup-shutdown-1791989063557-0.json` | `poll-catchup-fatal-1791989063573-0.json` | Both access nonexistent `h.control.bumpRetryAttempts`. |
| Initial: `pre-fix-first.test.ts.txt` | `poll-catchup-shutdown-1791989081410-0.json` | `poll-catchup-fatal-1791989081445-0.json` | Shutdown cannot drain; fatal times out at `crash captured`. |
| Final red: `pre-fix.test.ts.txt` | `poll-catchup-shutdown-1791989118899-0.json` | `poll-catchup-fatal-1791989118928-0.json` | Both time out at `sustained source must not block drain`. |

Logs: `fixture-red.log` / `fixture-replay-{shutdown,fatal}.log`; `red.log` / `replay-first-{shutdown,fatal}.log`; `red-final.log` / `replay-final-{shutdown,fatal}.log`.

Fixture corrections: use `h.deps.control`; inject fatal rejection through the independent task-runner boundary. The initial naming crash had no committed B input to trigger it, so that fatal trace is fixture-only. Initial shutdown already exposes the product defect. Both final scenarios reproduce it explicitly before production changes.

The source stays nonempty: three batches commit, a fourth commit is held, then shutdown or a peer history-lane crash occurs. Releasing only that commit leaves the old history loop draining forever. Fatal has emitted its single sanitized crash edge, but the sustained peer masks supervisor rejection.

## Correction and invariants

Check the dispatcher's effective stop signal between history rounds, including cursor-conflict retries. Shutdown and the first unexpected lane crash share that signal; sequential `pollLoop` also receives it. Admitted observation/history/commit I/O finishes under its existing deadline, without the stop signal aborting it.

`yielded` reports committed records without claiming caught-up or failure, clearing retries, or scheduling successful cadence. Unsignalled lifecycle barriers still require empty history. Held health/claim/delivery/history/commit/naming boundaries must drain before finish. The sustained source need not become empty.

The two corrected shutdown/fatal DSTs each pass 30 schedules. They require exactly four committed records, matching replica cursor/head, unchanged retries/cadence, no manufactured pull failure, preserved fatal identity, and one content-free `poll-task-crashed` edge. Healthy shutdown emits no crash edge.

## Reproduction

In an **isolated copy of the frozen audit/PR tree**, not `main`, set `EVIDENCE` to the absolute curated directory. Keep its independent naming implementation; only the two pre-shutdown production snapshots and old scenario are needed. Never restore these files in the active validation tree.

```sh
SHUTDOWN="$EVIDENCE/2/shutdown"
cp "$SHUTDOWN/baseline/loops.ts.txt" apps/control-plane/src/domain/loops.ts
cp "$SHUTDOWN/baseline/replication.ts.txt" apps/control-plane/src/domain/replication.ts
cp "$SHUTDOWN/pre-fix.test.ts.txt" apps/control-plane/src/domain/poll-concurrency.dst.test.ts
DST_REPLAY="$SHUTDOWN/poll-catchup-shutdown-1791989118899-0.json" \
  npx vitest run apps/control-plane/src/domain/poll-concurrency.dst.test.ts \
  -t 'drains sustained catchup on shutdown'
DST_REPLAY="$SHUTDOWN/poll-catchup-fatal-1791989118928-0.json" \
  npx vitest run apps/control-plane/src/domain/poll-concurrency.dst.test.ts \
  -t 'drains sustained catchup on fatal'
```

Expected: both reproduce `sustained source must not block drain`. To reproduce earlier stages, substitute the table's scenario and trace; selectors stay unchanged. Baseline snapshot and naming-dependency hashes are in `../../MANIFEST.md`.

## Focused validation

```sh
npx vitest run apps/control-plane/src/domain/poll-concurrency.dst.test.ts -t 'drains sustained'
npx vitest run apps/control-plane/src/domain/poll-concurrency.dst.test.ts \
  apps/control-plane/src/domain/loops.test.ts \
  apps/control-plane/src/domain/replication.dst.test.ts \
  apps/control-plane/src/domain/backend-placement.test.ts \
  apps/control-plane/src/domain/central-lifecycle.dst.test.ts \
  apps/control-plane/src/domain/orb-alerts.dst.test.ts
npm run typecheck --workspace @pi-orb/control-plane
npx biome check apps/control-plane/src/domain/loops.ts \
  apps/control-plane/src/domain/replication.ts \
  apps/control-plane/src/domain/poll-concurrency.dst.test.ts
```

All exited 0: two targeted tests × 30 schedules, then **76 tests / six files**, control-plane typecheck and scoped Biome. Original validation logs and hashes are listed in `../../MANIFEST.md`; repetitive green logs are not duplicated.

Post-fix strict replay is **not green**. `fixed-replay-shutdown.log` and `fixed-replay-fatal.log` diverge at positions **108 / 122**: recorded `poll:a random number: store latency: get orb` becomes the driver timer. The fixed lane stops after the fourth safe commit instead of starting another catch-up round. This is the deliberately removed round, not a new product invariant failure or uncontrolled schedule. Fresh schedules validate the corrected invariants; the original red traces and explicit pre-fix reproductions remain preserved.
