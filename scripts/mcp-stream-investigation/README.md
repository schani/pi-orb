# Inference tracing proxy

`startInferenceTrace(upstreamBaseUrl, { cutIsolationOnce? })` returns a forwarding `baseUrl`, in-memory `records`, and async `close()`. The caller owns cleanup and evidence capture. Records contain method, route, HTTP status, SSE event types, and termination classification, never payloads or credentials. `cutIsolationOnce` truncates the first request containing `MCP isolation` after `response.created`, including zstd-compressed requests.

After `npm ci`, run the retained proxy tests with the repository-local runner:

```sh
./node_modules/.bin/vitest run --config scripts/mcp-stream-investigation/vitest.config.ts
```

Historical stream-abort findings, sanitized first-failure ledger, controlled-injection limits, and mock fix validation: [docs/postmortems/2026-09-27-mcp-isolation-stream-abort.md](../../docs/postmortems/2026-09-27-mcp-isolation-stream-abort.md).
