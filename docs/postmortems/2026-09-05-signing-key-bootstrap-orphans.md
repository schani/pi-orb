# Signing-key bootstrap retries orphaned private-key versions

**Found and fixed: 2026-09-05.** This was a DST-discovered product defect, not a production incident. It blocked release during restart-notification validation.

## Evidence

The full unit suite failed `signing-key-boot-failpoints` at iteration 26: two simulated control-plane instances converged on one active key but left three unreferenced private-key versions (`v1`, `v2`, `v3`). The invariant permits at most one orphan per boot owner under the scenario's injected failures. A passing randomized rerun would not have cleared it.

The original recorded schedule is preserved both at `test-failures/signing-key-boot-failpoints-1788650084149-26.json` in the investigation workspace and, durably in the repository, at `docs/postmortems/2026-09-05-signing-key-bootstrap-orphans.trace.json`. Replaying it against pre-fix code reproduced the same assertion:

```sh
DST_REPLAY=docs/postmortems/2026-09-05-signing-key-bootstrap-orphans.trace.json \
  npx vitest run apps/control-plane/src/domain/signing-keys.dst.test.ts -t 'keeps converging while'
```

The trace's causal sequence:

1. Instance B writes `v1`; its active-row insert fails, then the following key-table read fails.
2. Instance A writes `v2` and encounters the same insert/read failure sequence.
3. Each outer boot retry invokes `ensureActiveSigningKey` again. Both calls have forgotten their previous candidates and create more material.
4. A later candidate wins the active slot. Destroying the loser's later version also fails, leaving a third orphan.

## Root cause

`generated`, `secretVersion`, and `referenced` were locals inside one `ensureActiveSigningKey` invocation. The inner four-attempt convergence loop reused them, but a read failure returned immediately. The outer retry loop in `main.ts` invoked the function again with empty ownership state. The design and invariant intended the entire boot retry episode to own one candidate, not each individual invocation.

Cleanup had a related defect: it ignored the typed `destroySecret` result, cleared the version even on failure, and emitted `issuer-key-race-lost` as though deletion had succeeded. That both lost the handle needed for repair and erased the forensic distinction between successful and unsuccessful cleanup.

## Fix and invariant

`SigningKeyDeps.bootstrap` is required, explicitly allocated alongside the instance's generator, outside the outer boot retry loop. `ensureActiveSigningKey` retains its candidate and acknowledged secret version there. There is no process-global cache, new database row, or cross-deploy compatibility phase.

- Failed reads, rejected inserts, and exhausted inner retries retain ownership.
- A successful insert or a subsequent read finding our `kid` transfers ownership to durable metadata and releases the local candidate. Lost insert acknowledgements must never cause deletion of referenced material.
- Failed destruction retains the cleanup handle. One `issuer-key-cleanup-failed` edge names the `kid`, secret version, and typed error code; no PEM is logged. A confirmed cleanup emits `issuer-key-race-lost` and releases the handle. Repeated failed attempts do not log levels.
- Once destruction has been attempted, the candidate is permanently barred from publication: a returned error might mean deletion committed but its acknowledgement was lost. If the active slot subsequently empties, bootstrap must first confirm idempotent cleanup before generating replacement material.
- One bootstrap owner admits one active ensure attempt. Overlapping calls receive a typed retryable error rather than racing on mutable ownership. Separate instances still race through the database's unique-active constraint.

This is volatile ownership for one running boot owner, not a durable orphan sweeper. Actual process death can still lose one pending acknowledged version. Nor does this fix invent a handle for a secret-store creation whose response was lost before any version identifier was observed; the discovered regression concerns versions already acknowledged to the caller.

## Verification

Tests were added before implementation and their failing traces replayed before the fix. `apps/control-plane/src/domain/signing-key-bootstrap.dst.test.ts` scripts the observed insert/read failure sequence across outer retries, inner-loop exhaustion, concurrent calls on one owner, committed-but-unacknowledged inserts, cleanup failures, and destruction failing both before and after commit followed by the active slot becoming empty. It asserts stable material identity, bounded generation, preservation of every referenced version, safe cleanup recovery, edge-only logging, and no key material in logs.

The original entropy trace is intentionally unchanged. With the fix it reports **replay divergence at position 78**: the recorded schedule expects another key-generation latency draw, but the fixed code reuses its candidate and proceeds to the insert. This is not a successful replay of the old schedule; the scripted regressions preserve its causal failure sequence without requiring the obsolete operation schedule. The original randomized invariant remains unchanged and passes alongside those regressions.

Validation: 43 focused signing-key/DST/route/real-crypto tests passed, then the full unit suite passed **1,088 tests** (one skipped). Typecheck passed. No deployment was performed.
