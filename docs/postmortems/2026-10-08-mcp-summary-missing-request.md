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

The hosted failure remains unexplained. The absent request could reflect a runtime summary decision, authentication failure, or transport failure before acceptance; retained evidence does not distinguish them. No product fix or deployment qualification follows from the local pass. The historical WebKit failure remains independently blocking.
