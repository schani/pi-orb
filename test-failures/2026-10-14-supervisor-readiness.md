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
