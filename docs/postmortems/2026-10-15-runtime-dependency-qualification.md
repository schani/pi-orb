# Runtime dependency qualification — 2026-10-15

## Decision and limits

[PR 122](https://github.com/schani/pi-orb/pull/122) separates cacheable install/patch and offline PTY compilation. Installed Node headers, removed prebuilds, network-disabled rebuild and real PTY spawn remove header-download dependence but do not establish the original stall’s cause. Phase markers preserve elapsed time and failures; image-ID checks and trusted writers remain fail-closed (`docs/deployment.md`).

Deploy [38800758118](https://github.com/schani/pi-orb/actions/runs/38800758118) stopped before production after two 600s whole-image-build timeouts. Retained evidence cannot establish the stalled phase or cause. **User-approved exception (2026-10-15):** “Yes, you may leave the historical image-build timeout’s cause unresolved.” Only explaining these historical timeouts is waived; first-failure evidence remains. The unrelated identity failure, new failures, exact-head qualification, assertions and DST replay/root-cause requirements are excluded. The exception itself authorizes neither merge nor deployment; no stall fix or speedup is claimed.

## Qualification receipts

PR 122 is merged. All eleven exact-main checks passed on attempt 1; no new deployment occurred. Current receipts and earlier head-scoped records:

| Source | Evidence / boundary |
|---|---|
| Main `8371a577` | [CI](https://github.com/schani/pi-orb/actions/runs/38823365031), [E2E](https://github.com/schani/pi-orb/actions/runs/38823365316), [Durable](https://github.com/schani/pi-orb/actions/runs/38823365070): all eleven checkout logs confirm the exact merge SHA. [Export receipt](https://github.com/schani/pi-orb/pull/122#issuecomment-6204665110), originals in `.context/pr122-main-cache/`. |
| Earlier PR heads | First-attempt greens and checkout/log/artifact hashes: [initial code](https://github.com/schani/pi-orb/pull/122#issuecomment-6202934012), [docs](https://github.com/schani/pi-orb/pull/122#issuecomment-6203374477), [fixture](https://github.com/schani/pi-orb/pull/122#issuecomment-6203950883), [final waiver docs](https://github.com/schani/pi-orb/pull/122#issuecomment-6204363503). Each receipt qualifies only its recorded head. |
| Local fixture head `cf91bc86` | `.context/pglite-hook/full-qualification/run-20261015-152847-RXB7GM/`: unit 4975 passed/38 skipped (699 files: 686 passed/13 skipped); infrastructure 285 passed (92 Node/166 Python/27 native); typecheck/lint passed, baseline 304 warnings/74 infos. Completed 3:54:39 PM PDT, serially with free ports and clean teardown; scope/skips and failure/trace inventory unchanged. |

Initial hosted PR builds executed uncached install/patch/offline PTY smoke, with one Buildx invocation per runner, exact build/setup image-ID matches and no PR exports. Import was requested but no dependency reuse observed. Main then verified shard-1-only GHA export (`mode=max`), import-only shards 2–4, matching image IDs and the scope index under `refs/heads/main`.

**Fresh-runner reuse remains unvalidated.** GitHub rejected the immutable-SHA workflow dispatch with HTTP 422; no run was created. This is not a test failure or pass. Remaining qualification: `TODO.md`; policy: `docs/testing.md`.

## First failures and corrections

Local originals below are `.context/` paths, not durable download links. Committed excerpts preserve findings; no traces were deleted or blind green-seeking retries used.

| Evidence | Finding |
|---|---|
| `.context/e2e-runtime-cache/red.log`, `.context/runtime-dependencies/red.log` | Tests-first: ten cache/setup and four dependency-layer failures. Corrected focused contracts passed (57 runtime/patch, 33 cache/harness, 20 dependency/APT plus preflight); obsolete install anchors changed without weakening layer ordering or single-build ownership. |
| `.context/runtime-dependencies/build-first.log` | Cold build passed: 257s total, npm 30s, patch 0s, PTY 5s, APT 187.9s. Offline compilation/spawn passed; not a controlled before/after benchmark. |
| `.context/e2e-runtime-cache/full-checks/vitest.log` | Exit 1 after 3455.27s: 4974 passed, one failed, 38 skipped; 685 passed/one failed/13 skipped files. Setup failure below; not a FIFO assertion. |
| `test-infra.log` in that directory | Node passed 92/92; Python rejected the obsolete blanket preflight ban on E2E prebuilds. A narrow contract correction reflects E2E build ownership. |
| `test-infra-after-fix.log` | Changed-test retry: Node 90/92; two preparation-signal fixtures missed `ready`. Python/native phases not reached. Port ownership established harness collision, not broken signal cleanup. |
| `test-infra-isolated.{log,exit,envproof}` | One authorized replay after verified port release passed all 285 infrastructure tests, with no implementation/test change from the collision. |
| `.context/e2e-first/full.log` | Parent-authorized cancellation after hosted qualification: exit 130 after 3541s at 2:48 PM PDT, no local failure observed. Partial local E2E is not a full pass; `cancellation.json` and process/port snapshots retain the receipt. |

### PGlite setup budget

```text
orb-sleep.matrix.store.test.ts:23:5, beforeEach
PGlite scheduled sleep FIFO matrix > freezes human -> sleep_wake -> human at the source FIFO head
Error: Hook timed out in 10000ms.
```

The default 10s hook limit differed from the configured 30s body budget. The exact slow step and original CPU/resource cause remain unproven; overlapping E2E alone establishes neither. One diagnostic passed both cases (9522ms for the originally failing case), which did not clear the failure.

**Decision (2026-10-15):** each backend's single case owns cold open/migrate/seed/project/orb setup within its unchanged 30s body budget and FIFO assertions. Checked cleanup registers at database acquisition, before migrate/seed, with its separate default 10s hook budget. No numeric deadline increase, production/schema change or shared database. This corrects budget ownership without claiming a CPU-cause fix.

`.context/pglite-hook/{budget-red.log,review-final/budget-green.log}` preserve the controlled `--hookTimeout=100` RED/GREEN: original `beforeEach` failed; both unchanged cases passed with early cleanup (PGlite 3099ms inside the 30s body). The override is diagnostic only.

Injected pre-migrate/pre-seed failures closed successfully; late registration did not. `review-final/` retains probes, 18 focused passes, typecheck/lint/diff checks. Isolated profiling measured first query 2776ms within 3058ms migration, then seed 3ms, project 5.6ms, orb 6.5ms, close 4.5ms: cold initialization dominated that observation, not necessarily the original timeout. The full serial local receipt above validates the structural correction, not the unproven cause.

### Fixed-port ownership

`scripts/local-fake-provider.test.mjs:413:3`, “actual wrapper SIGINT/SIGTERM cancels preparation and cleans owned descendant,” failed twice with `fixture checkpoint missing: …/ready` after 10702.8ms/10639.9ms. `infra-failure-{port-owners,resource-context}.log` in the full-checks directory establish that E2E held `*:3210` (PID 29592) and `[::1]:5173` (PID 29605) throughout. Preparation rejects occupied ports before fake `git init` can write `ready`; an earlier 92/92 Node pass could not clear the collision.

**Decision (2026-10-15):** full unit/infrastructure qualification and fixed-port local E2E run serially on one host; isolated runners may overlap. Cancellation released both ports before the authorized replay. This validates isolation, not a product signal-cleanup fix or an explanation/waiver of the PGlite timeout. Process/resource snapshots, fixture roots and first-failure logs remain in `.context/e2e-runtime-cache/full-checks/`.
