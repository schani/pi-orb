# PostgreSQL 17 PR qualification failures

[PR 226](https://github.com/schani/pi-orb/pull/226), head `50f851c5`, failed three qualification jobs:
- [CI 40797783131 / 123198322511](https://github.com/schani/pi-orb/actions/runs/40797783131/job/123198322511): two stale release contracts.
- [E2E 40797783065, shard 4 / 123198322292](https://github.com/schani/pi-orb/actions/runs/40797783065/job/123198322292): ambiguous status locator.
- [E2E shard 2 / 123198321976](https://github.com/schani/pi-orb/actions/runs/40797783065/job/123198321976): native Chromium renderer CHECK.

## Causes and corrections
Release tests expected exit 7/143 and lock release after failed/interrupted apply.
The existing uncertain-apply path sets `KEEP_REMOTE_LOCK=true`; cleanup returns 1 and retains the lock.
Both local failures reproduced before correction. Contracts now require apply reached,
retention diagnostics, no smoke and no unlock. All 28 release contracts and 22 preflight tests pass.

The drop test's global `getByRole("status")` matched both the new empty share notice
and the correct rejection feedback. Local reproduction failed identically; scoping to
`.orb-drop-feedback[role="status"]` preserves role, text and all other assertions. All seven file tests pass.

Shard 2 hit `window_performance.cc:1051`, `processing_start_time >= render_start_time`
(555367517 versus 555384882), in `ReportAnimationFrameTimingHistograms`, not a PostgreSQL assertion.
CI selected unmanaged `/usr/bin/chromium` despite installing locked Playwright engines.
The failed process's `Browser.getVersion` was not recorded: its exact revision is unproven.
An adjacent October 26 runner manifest lists 156.0.8078.0; that upstream tag contains this exact CHECK/function/line.
Local CDP reports installed Chromium 156.0.8078.4 at `@f842f52ef39fd97b449eb27cff414bf05a98ddce`:
that exact upstream [revert](https://github.com/chromium/chromium/commit/f842f52ef39fd97b449eb27cff414bf05a98ddce)
removes the function and reverted `02dc6ad8` because of crashes.
The workflow exports the locked package's `chromium.executablePath()` and logs `--version`.
This selects the corrected engine for launchers honoring that environment variable, including
frontend-session; direct system launchers are unchanged. No global browser pin or exact failed-binary attribution is claimed.
Two browser-selection contracts failed first; all 11 pass after correction, and 31 combined browser/CI contracts pass.
The unchanged frontend-session suite passes all 102 cases in 360.71s with an owned-worker exit-0 receipt.
The first full local attempt was cancelled by the outer 300s tool deadline, not a test assertion;
its log is preserved. The owned worker and exit receipt avoid that deadline without raising test timeouts.

## Evidence and qualification
Original logs/artifacts, local RED/GREEN and upstream sources remain under
`$HOME/.local/share/pi-orb/{pr226-ci-checks,pr226-e2e-shard4,pr226-e2e-shard2}/`.
All 19 uploaded trace JSONs match tracked historical fixtures byte-for-byte; no new DST failure required replay.
Final local lint (existing warnings), typecheck, infrastructure suite (120 Node, 238 Python, 34 native-VM)
and 28 release contracts pass; logs/exit receipts remain under `$HOME/.local/share/pi-orb/pr226-finalization/`.
No blind CI rerun, weakened assertion, raised timeout or application/prompt/schema/extension change.
Final PR-head and exact-main qualification passed; results: `docs/testing.md`.

## Second qualification
Head `fc36de79` passed all four E2E shards, four Durable shards and the image job.
[CI 40918603598 / 123605422991](https://github.com/schani/pi-orb/actions/runs/40918603598/job/123605422991)
reported 6,091 passed, nine skipped and one failure, `e2e/sharding.unit.test.ts:27`:
its literal `run: node ...` expected the single-line workflow before managed-browser
selection added a multiline run block.
The unchanged-head failure reproduced locally. The contract now checks the exact
export, version probe and unchanged supervisor/shard command together; no workflow changed.
All 16 related unit tests, 31 browser/CI contracts and E2E typecheck pass; focused
lint passes with two existing warnings. Repository-wide search
found no other stale E2E run-block expectation; the remaining single-line contract
checks the unchanged Durable workflow. The complete job log, RED/GREEN logs and
artifact comparison remain under `$HOME/.local/share/pi-orb/pr226-ci-second-failure/`.
All 19 artifact JSONs are byte-identical tracked fixtures; no new DST failure occurred.
