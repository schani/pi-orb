# PGlite qualification contention — 2026-10-14

Status: controlled CPU-starvation mechanism confirmed; original failure attribution incomplete. No product fix or deployment.

## Observation

At 12:13:55 PDT, the backend qualification run recorded three 10-second `beforeEach` timeouts before uppercase-target, reciprocal-send/deletion and atomic-peer-admission test bodies. Three in-memory cases passed; the CHECK case passed in 9,987 ms, including setup. Browser/process E2E and preview services were active on the shared two-vCPU VM. The original run lacks initialization-phase/resource telemetry.

First evidence remains unchanged: `.context/cross-orb/backend-store-qualified.log`.

## Controlled evidence

Under parent-granted exclusive ownership, unchanged source and unchanged timeouts:

- Before/after controls each passed seven selected cases: four PGlite, three in-memory. These overlapping controls are not additive coverage.
- Eight pipe-readiness-gated, CPU-only workers reproduced all three store hook timeouts plus the CHECK hook timeout. In-memory cases still passed.
- PGlite WASM readiness rose from 1.50–2.89 seconds to 8.36–12.65 seconds. Cold CPU cost stayed comparable: 4.85 → 5.23 → 4.79 seconds. Loaded CPU utilization/pressure approached 100%; iowait/steal were zero and available memory remained above 13 GiB.
- All 46 migrations completed without errors; migration 045 used 3.3–3.6 ms CPU. Every client closed before the next setup. No test-body transactions ran under load.

Vitest 4.1.11 checks elapsed time when a hook resolves even when microtasks prevented its timeout callback from running. The reproduced setup completed, assigned its subject, then failed that deadline check; teardown closed it. No setup-promise leak or SQL defect was reproduced.

This establishes a resource-contention failure mode, **not** the exact historical schedule or initialization stage. Eight synthetic workers do not reconstruct the original competing processes. An earlier diagnostic overlapped another E2E launch and is excluded from exclusive-control evidence.

Telemetry, source/log hashes, ownership joins, commands and limits: `.context/cross-orb/store-isolation/report.md`.

## Decision

One parent owns the shared-VM qualification slot through child cleanup. Separate unit/store, browser/process-E2E and static/build gates run serially; one runner's worker limit cannot isolate independent invocations. Idle preview services may remain. Preserve phase/CPU/memory evidence on failures. No timeout/assertion inflation or fixture refactor is justified.

This external gate-ownership correction does not grant a historical-cause waiver or replace full qualification. Rule: `docs/testing.md`.
