# Central MCP discovery blocked startup

All times October 22, 2026, America/Los_Angeles.

## Evidence

Orb `47645859-53e4-4560-a03a-73a113eacfb9`:
- 13:57:16.275: start requested.
- 13:57:30.820: replacement compute provisioned.
- 14:02:01.944 and 14:09:01.290: central-agent-unavailable, `tool discovery cancelled or unavailable`.
- 14:20:10.130: starting → failed; `deadline_exceeded`, 170 probes, runtime answered, last probe error `tool discovery cancelled or unavailable`.
- 14:20:31.297: compute discarded; retained boot evidence says runtime ready, 15,618,826,240 boot bytes and 46,759,006,208 workspace bytes free.

Read-only Cloud Logging query: target orb ID, `"lifecycle:"`, timestamps `2026-10-22T20:45:00Z` through `2026-10-22T21:25:00Z`. Ownership acquisition/release repeatedly occurred around ten-second attempts. This investigation did not restart or deploy the orb.

## Control flow and limits

The lifecycle's ten-second `runtimeRequestTimeoutMs` was shared by the complete central health/open or execution-readiness operation, not granted per MCP. Manager queuing, startup checks, resource/Git preparation, persistence and agent composition consumed that operation's budget. `withDeadline` aborts its signal; it does not force an immediate return.

Composition awaited MCP endpoints sequentially in catalog order. Endpoint construction did not contact the provider. The SDK then started its transport, initialized the MCP session, sent initialized notification, listed all tool pages, and closed the session before moving on. HTTP initialization also traversed scoped configuration/secrets/ownership checks and OAuth. The SDK's thirty-second request timeout was an inner component limit, not the lifecycle's budget.

The generic cancellation message lost the responsible server and active stage. Retained evidence cannot establish which provider, OAuth operation, HTTP request, tool-list page or cleanup stalled; provider attribution is not proven.

Two cancellation limitations were identified: the scoped fetch wrapper replaced the SDK signal, including its one-second DELETE-cleanup timeout; OAuth token admission received no caller context. An already-admitted rotating broker refresh intentionally settles under its own budget, independently of caller cancellation.

## Resulting decision

Remote MCP discovery starts automatically but cannot gate startup or unrelated tools. Rejected: discovery triggered only by `mcp_status`; it hides configured tools and depends on model choice. Native search ranks tool descriptions. Configured pending namespaces and inventory in the real status-tool description make providers searchable immediately.

Discovery starts after native initialization/final admission, before Harness resume; the resource lease owns it, not the incoming startup deadline. Each endpoint publishes before the next begins. Revocation aborts discovery before Harness close; final cleanup joins discovery/notifications even if cleanup fails. Native alerts and a cached model section expose failures without new input. Status returns cached progress and shares an optional consent retry. Full publication/context contract: `docs/mcp.md`.

Discovery retains serial per-server failure tolerance and the SDK per-request timeout. Caller cancellation stays cancellation. Preserve local configuration fail-closed behavior and mandatory owner/admission checks. Sanitized failure-only lifecycle traces retain server, phase, elapsed time and SDK category/status.

Current contract and observability fields: `docs/mcp.md`. No schema, timeout policy, deployment or target restart is part of this change.
