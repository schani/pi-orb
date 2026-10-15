# Runtime dependency qualification — 2026-10-15

## Scope and decision

[PR 122](https://github.com/schani/pi-orb/pull/122) implements trusted E2E BuildKit layers and offline runtime PTY compilation. Install/patch and PTY rebuild are separate layers; phase markers report elapsed time and preserve failures. Installed Node headers, removed prebuilds, network-disabled rebuild and native PTY spawn prove compilation without header downloads. Exact loaded-image ID verification and PR-read/main-write cache policy remain fail-closed (`docs/deployment.md`).

Original main [run 38800758118](https://github.com/schani/pi-orb/actions/runs/38800758118) was blocked before production by two 600-second runtime image-build failures. Their cause remains unproven. Removing header-download dependence is not proof of that cause or its correction.

## Hosted evidence

Code head `1110e7e0f3e0aa11f7299eb71c3b1801824365c5` passed attempt 1:

- [CI 38806119833](https://github.com/schani/pi-orb/actions/runs/38806119833): both jobs.
- [E2E 38806119871](https://github.com/schani/pi-orb/actions/runs/38806119871): all four shards.
- [Durable 38806119693](https://github.com/schani/pi-orb/actions/runs/38806119693): image plus four process shards.

The PR merge checkout was `3b001a8c2c8328f3bc1f7c9f8fdf5d4ea806793f`, parents base `18eb15b57f8bdd21d689004757ee74aee940a2ec` and that head. Job inventories and assertions were unchanged. All four runtime builds executed uncached install/patch/offline PTY rebuild/spawn, with one Buildx invocation per runner, matching action/setup image IDs, `CACHE_WRITE=false` and no cache export. Import was requested; dependency-layer reuse was not observed. Trusted main export and a subsequent fresh-runner hit remain unvalidated, not implied by these greens.

Observed at 2:20 PM PDT; `.context/pr122-hosted/{REPORT.md,runtime-evidence.json}` and all eleven completed-job logs/artifacts retain the detailed evidence. These results apply to the code head's PR checkout, not later documentation SHAs. No reruns or deployment were performed by the hosted observer.

## Local evidence and blockers

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

The 10000ms hook limit is the framework default. The exact slow setup step and resource cause are unproven. E2E overlapped; overlap alone does not establish causation.

The later infrastructure failures are at `scripts/local-fake-provider.test.mjs:413:3`: “actual wrapper SIGINT/SIGTERM cancels preparation and cleans owned descendant,” with `fixture checkpoint missing: …/ready` after 10702.8ms and 10639.9ms. The initial 92/92 Node pass does not clear these failures. `infra-failure-port-owners.log` and `infra-failure-resource-context.log` establish that the overlapping E2E wrapper held `*:3210` (PID 29592) and `[::1]:5173` (PID 29605) throughout these checks. Preparation rejects occupied ports before the fixture's fake `git init` can write its ready checkpoint. This is harness resource collision, not evidence of broken signal cleanup. Process/resource snapshots, fixture roots and failure logs remain under `.context/e2e-runtime-cache/full-checks/`.

**Decision (2026-10-15):** full unit/infrastructure qualification and the fixed-port local E2E wrapper run serially on one host; isolated runners may run concurrently. The redundant local E2E was cancelled under parent authority with no local test failure observed; both ports were then verified free. One authorized full infrastructure replay then passed under this corrected schedule. This validates infrastructure isolation, not a product signal-cleanup fix, and does not explain or waive the PGlite hook timeout.

## Qualification boundary

These committed excerpts preserve the findings; `.context/` paths identify local originals, not durable download links. First-failure evidence is preserved; no trace deletion or blind green-seeking retries. Hosted success and one local diagnostic pass do not waive unresolved non-UI failures. The actionable blocker is in `TODO.md`; qualification policy is in `docs/testing.md`. PR 122 remains draft: no merge, deployment, measured speedup or original-stall fix is claimed.
