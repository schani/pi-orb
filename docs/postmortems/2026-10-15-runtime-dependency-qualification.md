# Runtime dependency qualification — 2026-10-15

## Scope and decision

[PR 122](https://github.com/schani/pi-orb/pull/122) implements trusted E2E BuildKit layers and offline runtime PTY compilation. Install/patch and PTY rebuild are separate layers; phase markers report elapsed time and preserve failures. Installed Node headers, removed prebuilds, network-disabled rebuild and native PTY spawn prove compilation without header downloads. Exact loaded-image ID verification and PR-read/main-write cache policy remain fail-closed (`docs/deployment.md`).

Original main [run 38800758118](https://github.com/schani/pi-orb/actions/runs/38800758118) was blocked before production by two 600-second runtime image-build failures. Retained evidence does not identify the stalled phase or causal mechanism, so their cause cannot be established from it. Removing header-download dependence is not proof of that cause or its correction.

**Narrow exception (user-approved 2026-10-15):** “Yes, you may leave the historical image-build timeout’s cause unresolved.” Explanation of only these historical whole-image-build timeouts is no longer a merge/deployment requirement; no fix is claimed and first-failure evidence remains preserved. This excludes the unrelated historical identity failure and all new failures. Exact-head qualification, assertions and DST replay/root-cause requirements remain unchanged; no merge or deployment is authorized.

## Hosted evidence

Code head `1110e7e0f3e0aa11f7299eb71c3b1801824365c5` passed attempt 1:

- [CI 38806119833](https://github.com/schani/pi-orb/actions/runs/38806119833): both jobs.
- [E2E 38806119871](https://github.com/schani/pi-orb/actions/runs/38806119871): all four shards.
- [Durable 38806119693](https://github.com/schani/pi-orb/actions/runs/38806119693): image plus four process shards.

The PR merge checkout was `3b001a8c2c8328f3bc1f7c9f8fdf5d4ea806793f`, parents base `18eb15b57f8bdd21d689004757ee74aee940a2ec` and that head. Job inventories and assertions were unchanged. All four runtime builds executed uncached install/patch/offline PTY rebuild/spawn, with one Buildx invocation per runner, matching action/setup image IDs, `CACHE_WRITE=false` and no cache export. Import was requested; dependency-layer reuse was not observed. Trusted main export and a subsequent fresh-runner hit remain unvalidated, not implied by these greens.

Observed at 2:20 PM PDT; `.context/pr122-hosted/{REPORT.md,runtime-evidence.json}` and all eleven completed-job logs/artifacts retain the detailed evidence. Documentation head `1a577cacdad4a9d097c93d9015223d34ec3a92d8` also passed all eleven checks on attempt 1: [CI 38812939784](https://github.com/schani/pi-orb/actions/runs/38812939784), [E2E 38812939604](https://github.com/schani/pi-orb/actions/runs/38812939604), [Durable 38812939570](https://github.com/schani/pi-orb/actions/runs/38812939570). Logs, artifacts and hashes are retained in `.context/pr122-docs-head/receipt.json` (3:13 PM PDT). Feature and fixture head `cf91bc86022b51aa43190dc67262645736bb1801` then passed all eleven checks on attempt 1: [CI 38817437439](https://github.com/schani/pi-orb/actions/runs/38817437439), [E2E 38817437469](https://github.com/schani/pi-orb/actions/runs/38817437469), [Durable 38817437392](https://github.com/schani/pi-orb/actions/runs/38817437392). Tested merge checkout `495a084ea7c68cf1c1d6e2d74e7b0aabdf18ccfd` has parents base `77d449e5aaf7b1dcaed31e39fc11a1967f0a7278` and that head. Receipts, logs, artifacts and hashes are in `.context/pr122-fixture-head/` (observed 3:52 PM PDT). These results qualify that feature/fixture head, not a subsequent documentation SHA. No reruns or deployment were performed by the hosted observers.

## Local evidence

| Evidence | Result and limit |
|---|---|
| `.context/runtime-dependencies/build-first.log` | Cold image passed: 257s total; npm 30s, patch 0s, PTY 5s, APT 187.9s. Offline compilation/spawn passed; not a controlled before/after benchmark. |
| `.context/e2e-runtime-cache/full-checks/vitest.log` | Exit 1 after 3455.27s: 699 files (685 passed, 1 failed, 13 skipped); 5013 tests (4974 passed, 1 failed, 38 skipped). Failure excerpt below. |
| `test-infra.log` in that directory | Initial Node phase passed 92/92; Python then rejected an obsolete blanket preflight ban on E2E runtime prebuilds. A narrow committed contract correction reflects E2E's new build ownership; focused preflight passes. |
| `test-infra-after-fix.log` | Full retry was warranted by that changed test, but Node passed only 90/92: both preparation-signal fixtures missed their ready checkpoint because the overlapping E2E wrapper held the fixed ports. Python/native phases were not reached in this retry. |
| `test-infra-isolated.{log,exit,envproof}` | One authorized full replay after verified port release passed: exit 0, 92 Node, 166 Python and 27 native tests. No implementation/test change between collision and isolated run. |
| `sleep-matrix-diagnostic.log` | One diagnostic passed both cases (originally failing case: 9522ms); it does not clear the original timeout or prove a fix. |
| `.context/e2e-first/full.log` | Parent-authorized cancellation after hosted qualification: exit 130, 3541s, at 2:48 PM PDT. No local test failure observed; partial results are not a full pass. `cancellation.json` and before/after process/port evidence retain the receipt. |

The original unit failure is setup, not a FIFO assertion:

```text
orb-sleep.matrix.store.test.ts:23:5, beforeEach
PGlite scheduled sleep FIFO matrix > freezes human -> sleep_wake -> human at the source FIFO head
Error: Hook timed out in 10000ms.
```

The 10000ms hook limit is the framework default, distinct from the configured 30s test-body budget. The exact original slow step and CPU/resource cause remain unproven. E2E overlapped; overlap alone does not establish causation.

**Fixture decision (2026-10-15):** this contract has one case per backend. Cold open/migrate/seed/project/orb setup now shares that case's unchanged 30s budget with its unchanged FIFO assertions. Cleanup registers at database acquisition, before migrate/seed, checks close success and retains the separate default 10s hook budget. No numeric deadline increase, production code, persisted schema or shared-database change. This corrects known budget ownership without claiming to identify or fix the original CPU cause.

Tests-first evidence in `.context/pglite-hook/budget-red.log` and `review-final/budget-green.log`: `npx vitest run apps/control-plane/src/domain/orb-sleep.matrix.store.test.ts --hookTimeout=100` failed the original `beforeEach`, then passed both unchanged cases with final early cleanup; the PGlite case took 3099ms inside the 30s body. The 100ms override is diagnostic only. Injected pre-migrate/pre-seed failures both closed successfully; the earlier late-registration fixture did not close on injected setup failure. `review-final/` retains these probes plus 18 passing focused store tests, control-plane typecheck, scoped lint and diff checks. An isolated instrumented original (`isolated.{log,jsonl}`, `profile.test.ts`) measured cold first query 2776ms within 3058ms migrations (~282ms remaining), then seed 3ms, project 5.6ms, orb 6.5ms and close 4.5ms. Cold initialization dominated that observation; it does not identify which phase crossed the original 10s limit. Full isolated qualification of head `cf91bc86022b51aa43190dc67262645736bb1801` passed once under `.context/pglite-hook/full-qualification/run-20261015-152847-RXB7GM/`:

| Gate | Exit / elapsed | Result |
|---|---|---|
| Unit | 0 / 1441s | 699 files: 686 passed, 13 skipped; 5013 tests: 4975 passed, 38 skipped; scope/skips unchanged. |
| Infrastructure | 0 / 16s | 285 passed: 92 Node, 166 Python, 27 native. |
| Typecheck | 0 / 31s | All workspaces/E2E passed. |
| Lint | 0 / 7s | Baseline 304 warnings, 74 infos. |

Total 24m55s, completed 3:54:39 PM PDT. Serial execution, no overlapping E2E, clean source/teardown and ports 3210/5173 free; existing failure/trace inventory unchanged. This validates the structural fixture correction without proving the original CPU cause or relying on a blind rerun.

The later infrastructure failures are at `scripts/local-fake-provider.test.mjs:413:3`: “actual wrapper SIGINT/SIGTERM cancels preparation and cleans owned descendant,” with `fixture checkpoint missing: …/ready` after 10702.8ms and 10639.9ms. The initial 92/92 Node pass does not clear these failures. `infra-failure-port-owners.log` and `infra-failure-resource-context.log` establish that the overlapping E2E wrapper held `*:3210` (PID 29592) and `[::1]:5173` (PID 29605) throughout these checks. Preparation rejects occupied ports before the fixture's fake `git init` can write its ready checkpoint. This is harness resource collision, not evidence of broken signal cleanup. Process/resource snapshots, fixture roots and failure logs remain under `.context/e2e-runtime-cache/full-checks/`.

**Decision (2026-10-15):** full unit/infrastructure qualification and the fixed-port local E2E wrapper run serially on one host; isolated runners may run concurrently. The redundant local E2E was cancelled under parent authority with no local test failure observed; both ports were then verified free. One authorized full infrastructure replay then passed under this corrected schedule. This validates infrastructure isolation, not a product signal-cleanup fix, and does not explain or waive the PGlite hook timeout.

## Qualification boundary

These committed excerpts preserve the findings; `.context/` paths identify local originals, not durable download links. First-failure evidence is preserved; no trace deletion or blind green-seeking retries. Feature/fixture head `cf91bc86022b51aa43190dc67262645736bb1801` has full local and hosted qualification; a subsequent documentation head still requires all eleven exact-head CI/E2E/Durable checks. Trusted main cache export and a subsequent fresh-runner hit remain unvalidated. Remaining work is in `TODO.md`; qualification policy is in `docs/testing.md`. PR 122 remains draft: no merge, deployment, measured speedup or original-stall fix is claimed.
