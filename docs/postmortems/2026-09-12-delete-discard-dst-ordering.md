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
  -t 'permanent deletion completes'
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

**Resolved (2026-09-12).** The user chose one scenario asserting the invariant
valid under either ordering, trusting DST to explore both rather than forcing
or splitting schedules. The earlier proposal to hold discard pending and cover
completion separately was not selected. The scenario still requires successful
deletion and `state: deleting`; its marker may be `0` (pending) or `null`
(finalized), never another incarnation. All eventual orb-row, host, filesystem
and replica cleanup assertions are unchanged. Its name now describes deletion
racing discard, while the internal trace name is retained for reproducibility.

Before the change, targeted replay reproduced the original assertion failure.
After the change, the same trace passed that assertion and exhausted its recorded
events at the first cleanup wait: the original failure had ended the trace before
cleanup. This is evidence that the recorded failing prefix is accepted, not a
claim that a truncated trace replay validated cleanup. The unchanged 30-iteration
scenario, all five deletion DST tests, and the full unit/DST/infrastructure suite
then passed. The original trace remains committed. No timeout was increased and
no cleanup invariant was removed. The deployment blocker is resolved.
