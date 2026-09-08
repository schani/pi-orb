# Mixed-generation drain restart race

**Date:** 2026-09-07  
**Impact:** A DST rollout schedule ended a healthy orb in `failed` while stopping. Production was not affected.

## What happened

`mixed-generation-rollover` timed out waiting for `stopped` in CI. The original self-reproducing trace was lost before CI uploaded failure artifacts. The same failure was reproduced against the exact failing commit by increasing the scheduler's legal late-timer exploration, then normalized into a trace accepted by the standard 5% policy.

The reproduced sequence was:

1. The stop entered `stopping` at 16.5 s.
2. The new revision restarted the unreachable host at 40.0 s.
3. The old revision, whose liveness state was process-local, could not see that restart and restarted the same host again at 79.1 s.
4. The second 65-second boot reached runtime availability near 144.1 s. Repeated modeled request timeouts prevented the new revision from recording a successful pull before its grace, anchored to the first restart, expired near 160.0 s.
5. The new revision failed the drain with `drain_runtime_unrecoverable` at 164.6 s; the old revision obtained a pull about one second earlier, too late to change the other process's decision.

The product had two races. Separate revisions could restart the same boot because restart evidence existed only in each process's `ControlState`. A stale provision pass could also commit across specification replacement: replacement request and finalization did not advance `state_version`, and the provision commit checked no incarnation or pending-discard fence. One reproduced schedule discarded incarnation 0, then resurrected it after the durable row had advanced to incarnation 1. On GCE that stale VM could temporarily hold the retained data disk and delay incarnation 1.

## Fix

Host observations now carry the current host's last-start timestamp. During `stopping`, a reconciler that sees a new start in the current stopping episode adopts that boot's `postRestartGraceMs` window and emits `drain-restart-deferred`; it does not restart the same boot. Missing, invalid, future, old, and already-adopted timestamps retain the bounded existing behavior.

Specification-replacement requests and their `host_spec_changed` finalization now advance `state_version`; failed-disposal finalization leaves it unchanged so a queued wake retains its one boot attempt. Every provision commit also requires the expected incarnation and no pending discard. A stale commit compensates its provider side effect by discarding only the superseded incarnation; the orphan sweep removes a lower incarnation that survives a crash. GCE treats the known retained-disk attachment conflict as retryable while that cleanup completes.

`mixed-generation-drain-restart` deterministically stages the duplicate restart and asserts one restart; disabling adoption produces two. `mixed-generation-stale-provision` holds an old absence probe across discard/finalization and proves it cannot resurrect incarnation 0. `mixed-generation-pending-discard-provision` places the stale provider effect after discard but before finalization and proves the pending incarnation fence authorizes its immediate cleanup. The original rollover scenario retains its standard late-timer exploration.

## Prevention

- Cross-revision recovery decisions must use durable or provider-observed evidence, not only process memory.
- Provider side effects need a durable identity fence at commit and bounded compensation when that commit loses.
- Replacement authority changes must invalidate stale lifecycle snapshots.
- CI uploads simulation traces and lifecycle evidence on every failure.
