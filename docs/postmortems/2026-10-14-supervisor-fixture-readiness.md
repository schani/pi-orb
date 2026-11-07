# Supervisor fixture readiness and cleanup (2026-10-14; follow-up 2026-10-17)

First-failure record, moved from the former `test-failures/` ledger.

[Evidence archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/087158de-a85f-4594-8e0f-99270f568805/supervisor-signal-readiness/evidence.tar.gz), SHA-256 `7961d0fd0815b6a30ef8a76ddece0d3d0b1c8f28b94953c508777af3a8593ff4`: 52 files including controlled reds, pre-correction snapshots, corrected qualifications and the original failed CI log/triage. No orb transcripts or auth material.

## Original failure

[CI 38609611610](https://github.com/schani/pi-orb/actions/runs/38609611610) stalled in the supervisor integration tests. The stalled phase is **unknown**; timeout attribution and merge interaction are unproven.

## Findings

- Controlled SIGINT/SIGTERM reds prove readiness-before-signal-registration was a fixture defect.
- Startup-stall and group-kill-error witnesses failed before the teardown correction and pass after it.
- Ownership limit: actual spawn and parent IPC receipt are not atomic; a spawned but never reported group cannot be identified. The stall witness spawns no runtime; the error witness kills real groups before injecting failure.

## Follow-up: late-IPC cleanup race (2026-10-17)

A deterministic microtask witness: fixture kill queues exit, the exit waiter resumes, then a nested microtask delivers the runtime PID and natural IPC disconnect. Both the original group-first cleanup and an exit-only correction missed that group:

```text
FAIL  apps/orb-runtime/src/supervisor/process.integration.test.ts > runtime supervisor real processes > kills a runtime group reported after the fixture exits but before IPC disconnects
AssertionError: expected "kill" to be called once with arguments: [ -12345, 'SIGKILL' ]
Number of calls: 0
```

## Rules

- Install signal handlers before announcing readiness; held gates fence runtime execution and descendant readiness/exit.
- Cleanup never waits for an unknown PID. Kill/wait every owned fixture despite group errors; release sockets, servers and directories unconditionally; run all cleanups before propagating errors.
- Cleanup order: kill/wait the fixture, await natural IPC disconnect, then kill the latched runtime group. Node's natural EOF disconnect drains pending IPC; `connected === false` and child errors are not drain guarantees. Install the listener synchronously; exit rejection skips the disconnect wait. `close` is not the barrier: a runtime can inherit fixture stderr.
- Failures retain phases, PID/group and bounded stderr. PID-file publication is one synchronous write before readiness.
