# Central reconciliation task sharing

## Evidence

The first frozen PostgreSQL candidate unit gate (`/workspace/durable-next-evidence/qualification/test-02.log`) passed 2,903 tests but failed eight, with two unhandled errors. Six DST failures retained traces and were explicitly replayed before changes. Replays exposed `Task ... already has a resolve`: `reconcileOrbOnce` started central and compute reconciliation concurrently on the same `SimulationTask`. Determined models one sequential coroutine per task. Real-time-only overlap tests did not expose that violation.

The wrapper also raced compute's cached demand against central health/unload bookkeeping: stopped work could miss wake, or stale work could wake during a quiescent unload test. Two separate PostgreSQL tests failed because this gate omitted their required `PI_ORB_DURABLE_PG_TEST_URL`; the explicit test-cluster environment makes both pass. No skips or timeout changes were used.

The preceding full typecheck rejected an obsolete web streaming fixture's SQLite `stateDir`. That fixture also asserted replaced-owner reconnect semantics. It now exercises stable subscription continuity, passive history without reopening, stale admission refusal, and streaming before completion on the same socket.

## Fix

Remove duplicate central work from the compute wrapper. Existing central polling and compute reconciliation already run on independent tasks. Compute samples actual stable-handle work synchronously; required resource loading cannot block host allocation. Dispatcher/unload/suspension tests invoke the central operation they exercise. Their assertions remain intact; held-provision dispatcher DST covers independent tasks. The overlap test explicitly starts separate central and compute tasks.

The 23 affected orchestration/dispatcher/lifecycle/overlap tests pass. Their first post-fix run exposed two fixtures still invoking compute to test delivery; those traces were replayed before switching them to central dispatch. Evidence, frozen archives and subsequent qualification gates remain under `/workspace/durable-next-evidence/qualification/`.

## Invariant

Concurrent orchestration requires distinct simulation tasks. Do not hide task-sharing violations with production clocks, sequentialized resource acquisition, or weaker demand assertions. Frozen qualification must use the same dependency patches and explicit isolated database environment as the candidate.

This focused repair is not full candidate qualification or deployment.
