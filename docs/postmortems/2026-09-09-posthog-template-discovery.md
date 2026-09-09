# PostHog discovery rejected by optional template-list failure (2026-09-09)

## Symptom

The local process-hosted orb had adopted project MCP revision 1 and secret revision 1, and its project key was present. `mcp_search` nevertheless returned no entries and a generic unavailable error suggesting credentials or endpoint problems.

## Evidence and cause

A read-only diagnostic using the existing project binding succeeded at authenticated `server/discover`, `tools/list`, `prompts/list` and `resources/list`. The server exposed one `exec` tool, zero prompts and 265 resources. No PostHog tools were executed.

`resources/templates/list` returned HTTP 404 with a JSON-RPC 2.0 error whose code was -32601 (method not found). The official SDK reports non-OK HTTP responses as `SdkHttpError`; this response used `CLIENT_HTTP_NOT_IMPLEMENTED` with status/body in its structured data. Our adapter recognized only `ProtocolError(-32601)`, the shape produced by the existing HTTP-200 fixture. The optional-method check therefore failed to classify this response as unsupported and discarded the entire catalog.

## Fix and verification

The SDK boundary now also recognizes a bounded, structurally valid JSON-RPC method-not-found envelope carried by HTTP 404. It does not treat arbitrary 404s, malformed bodies, authentication errors or 5xx responses as unsupported. Only first-page failures of optional resource-list methods can be skipped; required methods and mid-pagination failures still fail discovery. Other HTTP failures expose their safe numeric status, never remote bodies or headers, through ordinary replicated tool results.

The real HTTP contract reproduces both HTTP-200 and HTTP-404 variants; negative mapping tests protect ordinary failures. The corrected production adapter's read-only search against PostHog returned 266 catalog entries with no failures. Credentials and endpoint configuration needed no changes.

The resulting rule is recorded in `docs/mcp.md`: qualify optional-method errors at the HTTP/SDK boundary, not only with idealized JSON-RPC success-status fixtures.
