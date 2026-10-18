# Pi SDK qualification receipts

Historical release and qualification evidence. Current contracts: `docs/pi-adapter.md`, `docs/subagents.md`; current qualification: `docs/testing.md`.

## September 30, 2026 release

The historical `orb.5` guidance artifact pinned [fork `1658ccb15a1c6cc8e88c9d16181910b111001964`](https://github.com/schani/pi-packages/commit/1658ccb15a1c6cc8e88c9d16181910b111001964), SHA-256 `c23e9671599b98982d558447af77a30954ab3fdfcb020e2d7bd1e7bb601c6bdc`. Its fork suite passed **80 files / 1,769 tests**; the installed registration contract checked the embedded guidance/profile change.

[Deploy 36777574484](https://github.com/schani/pi-orb/actions/runs/36777574484) validated exact commit `2f7c3f564bba250839cf85bd070593dc19e957d2`, release `r-1790802662-a4d05c55-2f4f-45c0-9672-26a752b1213a`: all twelve gates passed, including **233 E2Es**. Earlier attempts failed before apply: [36747361771](https://github.com/schani/pi-orb/actions/runs/36747361771) and [36772711420](https://github.com/schani/pi-orb/actions/runs/36772711420) encountered GCE stockouts; [36771730730](https://github.com/schani/pi-orb/actions/runs/36771730730) encountered Google credential HTTP 503.

## October 1–2, 2026 model-selection qualification

Orb `56e257bf-2145-4451-a43f-7d83c0a30d8a` demonstrated fuzzy `sol` selection choosing the older GPT-6 Sol. Fork `fc7134ba0694674e8b3546dd7b967815610f8f70` (`orb.7`) qualified explicit model resolution and empty-selector rejection: five of six new empty-selector regressions failed before repair; the previously installed artifact independently failed the contract. Fork checks passed **82 files / 1,785 tests**, typecheck and lint. Historical source bundle: `/workspace/rebase-backup/pi-packages-orb.7.bundle`.

The pre-empty-guard artifact passed **2,422 unit/DST tests, 110 infrastructure tests and 248 E2Es** (`/workspace/rebase-backup/final-*.log`). Final `fc7134ba` packaging passed typecheck/lint and targeted subagent/full-slice E2Es (**two files / five tests**), while the final unit suite included 26 installed-SDK schedules with actual scripted `gpt-6.1-sol` child requests. Final logs: `/workspace/rebase-backup/corrected-*.log`. The baseline full E2E pass did not qualify the final artifact; final unit counts and deletion-fixture replay are retained in `docs/testing.md`.

Orb `4c72af2b-d5ba-4083-948f-ed2d38833d3e` demonstrated unknown profile `sol` silently selecting `general-purpose` and inheriting Astra. The installed `orb.7` process fixture reproduced child admission and `gpt-6-astra` inference before repair. Corrected `orb.8` rejected both unknown profiles without child admission/inference; explicit `general-purpose` with model `sol` requested `gpt-6.1-sol` once; unknown models caused no new admission/inference. Both process subagent E2Es, including abort/crash/archive, passed.

The `orb.8` artifact pinned [source `29e2b3b44ae6cc7aa365b64f47b363c685b7d396`](https://github.com/schani/pi-packages/tree/29e2b3b44ae6cc7aa365b64f47b363c685b7d396), SHA-256 `d9afae712be5304e09a490f28b0493180c8565fe6585efe173b1daaab3e5cf2a`. Fork qualification passed **82 files / 1,787 tests**, typecheck and changed-file lint; full fork lint retained baseline failures. Installed artifact contracts passed **three tests**. The repository run recorded **2,422 passed, one failed, eight skipped**; the sleep-boot DST failure, exact replay and correction are preserved in `docs/testing.md`. Logs: `/workspace/rebase-backup/unknown-types/`. These were local qualification receipts, not deployment.

## October 6, 2026 failure diagnostics

The process-backed subagent E2Es collected failure-only, content-free runtime/activity/operation metadata, bounded native/replicated-history metadata and root/naming model-request summaries before teardown. Local capture preceded remote probes; native reads were capped at 64 KiB and each HTTP probe at three seconds without retries. Failed reads retained their status rather than appearing empty. CI retained `test-failures/subagent-*/failure.json` for fourteen days. The investigation disposition for E2E run `37415836008` is retained in `docs/testing.md`.

## October 12, 2026 restricted-child regression

Pi 1.1.0's installed restricted-child contract reproduced code-mode calling `mcp__cloudflare__read_0` despite a tool allowlist excluding MCP. The `orb.8` safety-patch correction excluded MCP tools/resources for that allowlist; the contract passed afterward without changing the vendor artifact. This was local evidence, not deployment or later-SDK qualification.

## September qualification archive

Original dated ledgers, archive hashes, first-failure diagnoses and qualification sequencing remain at [scripts/subagent-liveness/evidence/README.md](../../scripts/subagent-liveness/evidence/README.md). They retain their historical source/SDK scope; their passing checks do not qualify current central Durable.
