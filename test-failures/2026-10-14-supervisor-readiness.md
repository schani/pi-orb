# Supervisor fixture readiness — 2026-10-14

Base: `a60f497`; isolated `fix/supervisor-signal-readiness`, independent of PR #105.
[Evidence archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/087158de-a85f-4594-8e0f-99270f568805/supervisor-signal-readiness/evidence.tar.gz)
SHA-256: `7961d0fd0815b6a30ef8a76ddece0d3d0b1c8f28b94953c508777af3a8593ff4`.
52 evidence files; internal SHA256SUMS passed after extraction. Original sources/logs are unmodified.
Includes controlled reds, pre-correction snapshots, corrected qualifications and original failed CI log/triage/excerpt; no orb transcripts or auth material.

Controlled SIGINT/SIGTERM reds prove readiness-before-registration is a fixture defect.
[CI 38609611610](https://github.com/schani/pi-orb/actions/runs/38609611610)'s stalled phase remains UNKNOWN; original timeout attribution and merge interaction are unproven.
Startup-stall/group-kill-error witnesses fail before teardown correction, pass afterwards; first reds retained.
Cleanup never waits for an unknown PID; every owned fixture is killed/waited despite group errors, and all cleanups run before errors propagate.
Early IPC rejection stays observable by tests; sockets/servers/directories are released unconditionally.
Ownership limit: actual spawn and parent IPC receipt are not atomic; a spawned but never reported group cannot be identified. The stall witness spawns no runtime; the error witness kills real groups before injecting failure.

Final frozen source: 40 supervisor unit/DST/integration tests (38 existing + two witnesses), root types and lint pass; existing 294 warnings/44 infos.
Worktree `npm ci` was already completed. No production changes, increased deadlines or DST trace deletion.
No full-suite/E2E, remote CI or deployment qualification.

## Follow-up — 2026-10-17

A deterministic microtask witness exposed a late-IPC cleanup race: fixture kill queues
exit, the exit waiter resumes, then a nested microtask delivers the runtime PID and
natural IPC disconnect. Both the original group-first cleanup and an exit-only
correction missed that group. Compact original failure excerpts (ANSI stripped):

Original cleanup:

```text
FAIL  apps/orb-runtime/src/supervisor/process.integration.test.ts > runtime supervisor real processes > kills a runtime group reported after the fixture exits but before IPC disconnects
AssertionError: expected "kill" to be called once with arguments: [ -12345, 'SIGKILL' ]
Number of calls: 0
```

Exit-only correction:

```text
FAIL  apps/orb-runtime/src/supervisor/process.integration.test.ts > runtime supervisor real processes > kills a runtime group reported after the fixture exits but before IPC disconnects
AssertionError: expected "kill" to be called once with arguments: [ -12345, 'SIGKILL' ]
Number of calls: 0
```

Cleanup now kills/waits the fixture, awaits natural IPC disconnect, then kills the
latched runtime group. Node v24's natural EOF disconnect drains pending IPC delivery;
`connected === false` and child errors are not drain guarantees. The listener is
installed synchronously; exit rejection skips the disconnect wait. `close` is not the
barrier: a runtime can inherit fixture stderr and keep it open until group cleanup.
The witness asserts exit → PID delivery → disconnect → group kill, without deadlines.
The pre-spawn witness uses an unresolved-PID getter trap; PID-file publication uses
one synchronous write before readiness.

Historical qualification above remains scoped to its frozen sources. Final follow-up
source passes locally:

- `npx vitest run apps/orb-runtime/src/supervisor`: 46 tests, four files.
- `npm run typecheck`: pass.
- `npm run lint`: pass (394 warnings, 84 infos).
- `git diff --check`: pass.

No full-suite/E2E, remote current-head or deployment qualification is claimed.
