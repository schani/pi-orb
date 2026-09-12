# Deletion/discard DST assumes an unforced intermediate state

## Finding

The full unit/DST validation of the atomic output handoff found an independent
failure in `apps/control-plane/src/domain/orb-deletion.dst.test.ts`, scenario
`delete-supersedes-discard`, iteration 8. No control-plane implementation or
scenario code was changed by the handoff task. The initial full test run had
passed; the later run's failure was preserved, not dismissed as noise.

The retained trace is
`test-failures/delete-supersedes-discard-1789255100335-8.json`. Replay the exact
scenario (not every unrelated scenario in the file) with:

```sh
DST_REPLAY=test-failures/delete-supersedes-discard-1789255100335-8.json \
  npx vitest run apps/control-plane/src/domain/orb-deletion.dst.test.ts \
  -t 'permanent delete supersedes'
```

Targeted replay reproduced the same failure. A first file-wide replay also
reproduced it but produced expected replay-divergence errors in the other
scenarios; those different scenarios must not consume this scenario's entropy.

## Interleaving and classification

The test requests compute discard and concurrently runs the reconciler, then
requests permanent deletion. It asserts that the returned deleting row still
has `hostDiscardThroughIncarnation: 0`. It does not hold the discard operation
pending until that assertion.

The trace records these virtual times (milliseconds):

- failure/discard request: 4.319;
- reconciler provider discard completed: 31.058;
- driver's orb read: 31.058;
- reconciler finalized host discard: 33.159;
- driver committed permanent deletion: 34.188.

`finalizeHostDiscard` clears `hostDiscardThroughIncarnation` in the store. The
assertion therefore observes deletion after a completed discard, not the pending
discard its expected intermediate row assumes. This is an unforced scenario
ordering assumption, not evidence of a regression in streamed output or an
unsafe deletion outcome. The failed intermediate assertion prevents the scenario
from reaching its eventual cleanup assertions, so the trace does not establish
those final outcomes either.

## Status

The trace remains preserved and the scenario unchanged. This blocks deployment
until the scenario explicitly controls the intended pending-discard ordering
and separately covers completion-before-deletion without dropping its cleanup
invariants. The actionable item is in `TODO.md`. No green rerun of the full suite
or timeout increase was used to clear it.
