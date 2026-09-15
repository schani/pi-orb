# Terminal retry E2E counted pre-ready StrictMode transports

**Date:** 2026-09-14. **Classification:** test synchronization/ownership defect, discovered while qualifying personal instructions. No production terminal behavior changed.

## First failure

The first `PI_ORB_E2E_BACKEND=process npm run test:e2e` run completed with 52 passed, one failed and two explicit platform skips. All four full-slice runtime/lifecycle cases and both personal-instructions browser cases passed. The failure was:

```text
frontend-only browser behavior
  keeps delayed terminal readiness hidden and exposes an explicit retry after exit
  e2e/frontend-session.e2e.test.ts:1130

await expectPage.poll(() => opens).toBe(2)
Expected: 2
Received: 3
Timeout 5000ms exceeded while waiting on the predicate
```

The original complete log is preserved in this task's `/tmp/personal-e2e-all.log`, with an immediate failure snapshot in `/tmp/personal-e2e-first-terminal-failure.log`. Diagnostic trace: `/tmp/personal-terminal-trace.json`. This was not cleared by rerunning for green or changing a timeout.

## Diagnosis

`@wterm/react` creates/destroys WTerm instances from its React 19 callback ref. The dev fixture runs StrictMode. An initialization callback can be current when it executes, open a WebSocket, and then be replaced by the second StrictMode emulator before terminal readiness. `OrbTerminal.onReady` correctly closes the previous socket and fences callbacks by current socket identity. Whether the first socket reaches `onopen` before replacement depends on scheduling.

A diagnostic run used an independent Vite cache and test-only observations of emulator identity, current ref identity, socket creation/open and closure. Twelve explicit retry cycles showed two successively valid initialization callbacks per generation, while only the final peer remained active. A representative observed sequence was:

```text
5375.4 ms ready-callback wt=45 current=45 socket=null
5382.0 ms ready-callback wt=46 current=46 socket=47
           superseded socket closed
5389.3 ms socket-open wt=46 current=46 socket=48
           one active peer
```

The failing schedule additionally opens the earlier peer before it is closed, increasing the cumulative count without leaving two owned terminals. The earlier terminal presentation work already documented this StrictMode effect (`docs/terminal.md`), but only the hide/show test used post-readiness ownership; the retry test retained an absolute pre-ready count.

There was an unrelated source-format HMR edge at 23:04:00, before this case (the preceding cases took about 42 seconds). The isolated-cache diagnostic reproduced the two valid emulator callbacks without HMR. No evidence required changing the production terminal or personal-instructions implementation.

## Fix and qualification

The frontend test's Vite transform now provides a test-only readiness checkpoint and emulator ordinal on the intercepted socket URL. No transform or hook ships in production. This case holds the second StrictMode initialization of each generation until explicitly released, then waits for exactly that generation's final peer (`2`, then `4`) to be the **only** active socket. Superseded peers must close; the retry must create new transport ownership. Total pre-ready opens are no longer mistaken for the number of live terminal sessions. After confirmed recovery the transport count must remain stable, the retry action disappears, and the original draft remains.

The focused ownership regression passed with the explicit checkpoints. The final complete process-backed E2E rerun passed all 53 applicable tests (including the full 27-case affected frontend suite), with two explicit platform skips; source stayed unchanged throughout. Final results are recorded in `docs/testing.md`. This is a cause-based synchronization fix, not accepting intermittent failures or weakening the product's one-owned-terminal invariant.
