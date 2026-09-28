# MCP SSE diagnostic experiment

The mock source is [`glideapps/fake-openai`](https://github.com/glideapps/fake-openai) at `34dc7889ae7cfc48d2db39b7131c13d01b95481c`. Its `src/worker/stream.ts` conflates cancellation and stream-loop failure as `aborted`.

To reproduce the pi-orb fault **without changing the normal E2E**:

```sh
git apply scripts/mcp-stream-investigation/instrument-e2e.patch
PI_ORB_E2E_BACKEND=process PI_ORB_MCP_TRACE=1 PI_ORB_MCP_CUT_ISOLATION=1 npm run test:e2e -- e2e/mcp.e2e.test.ts
# The injected failure is expected; preserve the sanitized .context/mcp-failures artifact.
git apply -R scripts/mcp-stream-investigation/instrument-e2e.patch
```

The proxy (`inference-trace.ts`) records SSE event types, HTTP status, route, and termination only; it never logs payloads or credentials. The reproduction's *proxy-induced* cutoff consumes rule 9 and triggers the same retry and assertion, but its mock request differs from the original: `aborted=false`. The original mock ledger's `aborted=true` cannot identify the initiating cancellation versus a post-commit event-write failure. Run `npx vitest run --config scripts/mcp-stream-investigation/vitest.config.ts` for the proxy's unit tests.

The **mock-stream fix** and tests are also exported under `.context/mcp-stream-investigation/` (ignored by Git); its README identifies `fake-openai-stream-fix.patch` and the new test, plus the superseded provenance-only patch. The fix was pushed to [`glideapps/fake-openai` main at `63d84342`](https://github.com/glideapps/fake-openai/commit/63d84342b13fc9b0fb222f10960497c7dec38c87). The user confirmed deployment; live `/docs` documents `event_log_failed`, consistent with the fix but not proof of the deployed binary SHA. Default Docker-backed pi-orb E2E passed 227/227 against the deployed mock. The fix keeps D1 diagnostic writes from truncating valid SSE, with durable `event_log_failed` provenance if finalization succeeds. The fixed local mock passed 100 tests, worker typecheck, and targeted real Pi/browser MCP E2E on the process backend. Neither that pass nor the deterministic write-failure reproduction proves what triggered the original production request.
