# MCP summary assertion: no request reached the mock

## Evidence (2026-10-08)

Source `65e67612461e5278758ac3c55d04c193ccf14ee8`, [E2E run 37731459058](https://github.com/schani/pi-orb/actions/runs/37731459058), shard 3, failed `e2e/mcp.e2e.test.ts`: `first MCP summary consumed its scripted rule`.

Original job log: `.context/pr66-webkit-root-cause/diagnostic-ci-failed.log`. Downloaded artifact and retained hosted mock ledger/scenario: `.context/mcp-37731459058/`. The session was queried before its 24-hour expiry; its raw ledger contains synthetic credentials and prompts and is not committed.

The model ledger contains exactly three requests:

| Request | America/Cancun time | Rule | Result |
| --- | --- | --- | --- |
| 74247 | 00:31:19.047 | 0 | MCP codemode call, HTTP 200, `response.completed` |
| 74248 | 00:31:19.499 | 1 | Reasoning and FIFO gate, HTTP 200, `response.completed` |
| 74251 | 00:31:29.024 | 2 | `MCP_CHECK_COMPLETE`, HTTP 200, `response.completed` |

No fourth model request reached that session. Rule 3 was the notification-summary matcher. This is not evidence of a missed matcher: there was no summary payload to inspect. The mock's `finalized:false` fields do not establish stalled agent responses; all three delivered completed SSE events, and the test observed the final answer and replicated completion.

The fixture wrote its failure summary to `.context/mcp-failures/68fa40d1-6bb1-4b22-a9e9-6f74535af456.json`, which the workflow did not upload. Teardown removed the runtime. The only uploaded artifact contained existing DST traces, not this failure; no DST trace is implicated.

A pointed process-backend diagnostic retained runtime logs while executing the MCP test. It passed with four successful Luna summaries (`pointed-process.log` and `tmp/` under the evidence directory). This does not clear the hosted failure or establish its cause.

## Correction and limits

Failure summaries now use `test-failures/mcp-<uuid>.json`, covered by the existing CI/E2E artifact glob and Deploy's failure-only `mcp-*.json` allowlist with 14-day retention. The Deploy contract pins the path, action revision and retention; it failed before the upload step was added. A regression pins that directory and filename; artifact/diagnostic tests passed 7/7 after the expected red run. No timeout, script matcher, runtime behavior, or assertion was changed.

The absent request remains unexplained. It could reflect a runtime summary decision, authentication failure, or transport failure before acceptance; retained evidence does not distinguish them. The failed assertion nevertheless required optional best-effort notification inference, contradicting `docs/pi-adapter.md`. A passing diagnostic cannot establish the historical cause.

The corrective fixture isolates summary ownership at the existing mock transport boundary. Its HTTPS server serves exact summary prompts with a repeatable local Responses SSE answer and forwards ordinary root/child inference unchanged. Summary rules and consumption barriers are removed from the forward-only root script; notifications are explicitly outside MCP qualification. This preserves root/restricted/default-child MCP configuration and authentication-isolation assertions, without a production flag, model failure injection or external mock deployment.

Tests were written before the helper. A forwarding-only implementation failed five cases while two passed; enabling local summary ownership passed the initial seven, including real Luna SDK parsing. Deterministic schedules cover absent, early, late and repeated summaries; a held root request verifies concurrent summaries cannot advance root ownership. Compressed forwarding and near-match prompts retain ordinary inference. Failure artifacts record only summary/forward/failure counts, never prompt or auth content. Local validation does not identify the historical missing-request cause or qualify deployment. The historical WebKit failure remains independently blocking.

**Local qualification:** after `npm ci`, the pointed router/artifact/diagnostic suite passed 16/16; repository typecheck and lint passed (111 existing warnings, 16 infos). The first post-fix process-backed MCP E2E passed in 103 seconds, retaining all MCP feature assertions. Initial typecheck rejected a constructor parameter property and `Promise.withResolvers` against the repository's TypeScript settings; explicit fields and a local promise gate corrected those test-helper issues. No E2E rerun was needed. Red/green, typecheck, lint and E2E logs: `.context/mcp-router-qualification/`. No commit, push or deployment was performed for this qualification.
