# PostHog project selection lost between calls

## Evidence — 2026-11-06 (PST)

Orb `5959e19d-7330-4858-947d-ea5042327a9f` stopped before flag activation:
- November 6, 12:11 PM, records `8177`/`8197`: switching to production `365443`
  reported success; the next project read and flag URL identified preview `366534`.
- November 3, 9:14 AM, record `4491`: switching to preview `366534` instead
  left reads identifying production `365443`. No agent flag writes were observed.

At 12:33 PM, an independent authenticated `initialize` returned HTTP 200,
protocol `2025-11-25`, `PostHog 1.0.0` and a present `Mcp-Session-Id` header.
Only initialization contacted PostHog: no refresh, switch or business operation.
Binding checks matched current catalog revision 7 and its unexpired OAuth grant;
this does not establish the historical catalog. Tokens remained in memory;
raw bodies and session identifiers were not retained. Sanitized evidence:
`.context/posthog-20261106/live-evidence.json`.

## Cause and limits

Pi created, initialized and closed a fresh client/HTTP transport for each call,
including consecutive calls in one codemode script. Public PostHog source at
`99e258df8b5c308f8fcb19464a031e6f35c06b21` documents
[session-local project selection](https://github.com/PostHog/posthog/blob/99e258df8b5c308f8fcb19464a031e6f35c06b21/services/mcp/README.md#L415-L425),
[fresh legacy session issuance](https://github.com/PostHog/posthog/blob/99e258df8b5c308f8fcb19464a031e6f35c06b21/services/mcp/src/hono/dispatcher.ts#L280-L327)
and [credential/session-bound context](https://github.com/PostHog/posthog/blob/99e258df8b5c308f8fcb19464a031e6f35c06b21/services/mcp/src/hono/request-context.ts#L77-L91).
Together these explain both resets. Transport sessions take precedence over
PostHog's application `conversation_id`, so echoing that handle cannot bridge
freshly initialized legacy sessions. Public source is not the provider's proven
deployed revision; `PostHog 1.0.0` does not identify it. No live same-session
switch/read comparison or modern negotiation was performed.

## Decision — 2026-11-06 (local, undeployed)

Use the already-pinned official MCP client with automatic modern negotiation
and legacy fallback. The previous Pi client supported only legacy initialization;
the [modern protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
has no protocol-level sessions. Retained-session machinery is unnecessary for
modern transport: per-script clients would not span scripts, while retained
conversation clients would require isolation and restart semantics. Per-call
ownership remains; application handles still belong to the caller. This does not
qualify live modern PostHog behavior or establish mutation-target safety.
Current contract: `docs/mcp.md`; local checks: `docs/testing.md`.
