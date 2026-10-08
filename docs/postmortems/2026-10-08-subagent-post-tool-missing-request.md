# Subagent E2E post-tool stalls — 2026-10-08

Status: unresolved non-UI release blockers; evidence capture only.

## Evidence

Normal E2E [37734950460, attempt 1, shard 2](https://github.com/schani/pi-orb/actions/runs/37734950460/job/113172262915), source `db261fae2fe134cf0d657c4d728ad2247b3f65b0`, failed both tests in `e2e/subagents.e2e.test.ts`:

- **Delegated work through abort/recovery/archive:** line 317 waited 60 seconds for `PARENT_SETTLED_2`. Root ledger admitted and started child 2, then persisted both tool results at 01:08:19.681 America/Cancun. No subsequent root assistant entry appeared. The model ledger ends at rules 9 (root delegation) and 10 (child); no following model request was recorded. Runtime health remained ready/busy with the operation ID. Capture's phase was still `abort`: failure preceded the assignment to `recovery`, not proof that abort itself failed.
- **Unknown profiles/models and explicit Sol dispatch:** line 658 timed out waiting for `PROFILE_SETTLED_0`. Root ledger persisted the subagent tool result at 01:09:44.959 America/Cancun. Model evidence contains only the initial rule-0 request, not a continuation. Runtime health remained ready/busy.

Preserved originals: `.context/pr66-webkit-cohort-diagnostic/37734950460-job-113172262915.log` and `.context/pr66-webkit-cohort-diagnostic/normal-e2e-artifacts/e2e-dst-failure-traces-2-37734950460-1/subagent-{lifecycle,profiles}/failure.json`.

An unchanged, pointed process-backend baseline completed both tests locally (197.214 seconds and 67.766 seconds; total 267.27 seconds). Log: `.context/pr66-subagent-diagnostic/baseline.log`. It neither reproduces nor clears the hosted failures. Completed tests were not rerun.

## Limits

The original bundles retained root entry identities, tool-result presence, runtime activity and mock event counts, but discarded active stream state and persisted `pi-orb.stream-audit` metadata. Runtime logs and raw native/provider contents were not uploaded. Test cleanup deleted the mock sessions. The available evidence cannot distinguish SDK boundary work, broker admission, pre-acceptance transport failure, or another stalled continuation.

Naming uses an independent mock session. Neither failing continuation shows a competing request advancing the inference cursor. The MCP summary-cursor finding therefore does not establish these failures' cause. No lifecycle DST failure trace is implicated by these two E2E failures; unrelated historical traces in the artifact are not reproductions of them.

## Evidence decision — 2026-10-08

Extend only the test failure adapter: retain bounded, explicitly whitelisted active-stream and persisted-audit IDs, numeric timings/counts/status, event categories, phases, transport and issue/terminal categories. Exclude prompts, tokens, payloads, free-form errors and runtime/auth logs. Keep the existing 64 KiB/30-entry local tail and at most 30 active stream rows; missing older audits remain a diagnostic limit. Existing `test-failures/subagent-*/failure.json` artifact retention covers the addition.

This is not a corrective lifecycle change or release qualification. Do not infer repair from a passing local probe, broaden retries, weaken assertions or increase timeouts. The separate historical WebKit engine-error gate is unchanged. Actionable work is tracked in `TODO.md`.
