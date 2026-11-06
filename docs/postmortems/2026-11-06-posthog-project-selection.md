# PostHog project selection lost between calls

All incident times America/Los_Angeles (PST).

## Evidence — 2026-11-06

Orb `5959e19d-7330-4858-947d-ea5042327a9f` stopped before flag
activation because reads contradicted its requested project:

- November 6, 12:11 PM, records `8177`/`8197`: switch to production
  `365443` reported success; subsequent `project-get` and flag URL identified
  preview `366534`.
- November 3, 9:14 AM, record `4491`: the reverse occurred after switching
  to preview `366534`; reads identified production `365443`.

No flag writes by the agent were observed. Current catalog revision `7` used
PostHog OAuth connection `129a84a3-1b55-4c72-b301-909ce0e24580` with
`headers: {}`. This does not prove either historical catalog. Production was
`pi-orb-issuer-00087-tf6`, image
`sha256:80273f4941f55ff6c1d32803ba654d4620e729f8e1502895011292dc52a47240`.

At **12:33 PM** (`2026-11-06T20:33:36.065Z`), an independent authenticated
`initialize` returned HTTP **200**, protocol `2025-11-25`, server
`PostHog 1.0.0`, and a present `Mcp-Session-Id` header. No conversation ID was
returned. Read-only binding checks matched catalog revision `7`, OAuth row
version `8` and generation `4` to the exact project/connection; the existing
access token was unexpired.

Only initialization contacted the provider. No refresh, exchange, project
switch or business read/write occurred. Tokens stayed in memory; neither
raw response bodies nor session identifiers were retained. Sanitized evidence:
`.context/posthog-20261106/live-evidence.json`.

## Session-lifetime mismatch

The incident execution path created, initialized and closed a client for every
invocation in `apps/control-plane/src/adapters/durable/tools/mcp.ts`, constructing
a fresh HTTP transport in `apps/control-plane/src/process-agent-composition.ts`.
Consecutive calls, including calls in one codemode script, lost session continuity.

Public PostHog source at `99e258df8b5c308f8fcb19464a031e6f35c06b21` establishes:

- [Session contract](https://github.com/PostHog/posthog/blob/99e258df8b5c308f8fcb19464a031e6f35c06b21/services/mcp/README.md#L415-L425):
  an unpinned session starts from the user's active project within credential
  scope; a switch changes only that session.
- [Initialization](https://github.com/PostHog/posthog/blob/99e258df8b5c308f8fcb19464a031e6f35c06b21/services/mcp/src/hono/dispatcher.ts#L280-L327):
  legacy initialization mints a fresh MCP session ID.
- [Selection namespace](https://github.com/PostHog/posthog/blob/99e258df8b5c308f8fcb19464a031e6f35c06b21/services/mcp/src/hono/request-context.ts#L77-L91):
  selected context is credential/session-bound.

The live initialization confirms session issuance; the per-call lifetime and
public selection contract explain both directions of the mismatch. The public
commit is not the live provider's proven revision, and `PostHog 1.0.0` does not
identify it. No live same-session switch/read comparison was performed.

PostHog also carries application selection through echoed `conversation_id`.
Transport session IDs take precedence in the inspected implementation, so that
handle alone cannot bridge freshly initialized legacy sessions. Project pins
support `x-posthog-project-id` or URL `project_id`; an unchanged pin within one
session preserves switches rather than overriding every call. Public excerpts:
`.context/posthog-20261106/upstream-contract.md`.

## Protocol and package findings

Read-only inspection at **1:27–1:43 PM** established:

- The official [latest specification](https://modelcontextprotocol.io/specification/latest)
  redirects to `2026-07-28`. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
  removes protocol-level sessions and GET streams; [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
  replaces initialization with per-request metadata. [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
  is standard MCP, not a PostHog extension. Legacy `2025-11-25` already allowed
  sessionless servers, but still used initialization.
- Locked/latest [`pi-mcp@1.5.0`](https://registry.npmjs.org/@earendil-works%2fpi-mcp)
  initialized and supported revisions only through `2025-11-25`. All 14 published
  versions had no prereleases; the only dist-tag was `latest: 1.5.0`.
  [Upstream main at `6bf2ab9`](https://github.com/earendil-works/pi/blob/6bf2ab9bbb64fd14793e506a5404078441219b95/packages/mcp/src/protocol/types.ts#L4-L10)
  had the same limit. No compatible package upgrade was available.
- **Correction at 1:34 PM:** official [`@modelcontextprotocol/client@2.4.0`](https://registry.npmjs.org/@modelcontextprotocol%2fclient)
  and exact core `2.4.0` were already installed and locked. Their latest tags
  matched. `versionNegotiation: { mode: "auto" }` enables modern negotiation
  with legacy fallback; the default is legacy. Legacy version constants alone
  do not describe complete SDK support. The description probe already used auto;
  Pi execution still used `pi-mcp`.
- Legacy [`@modelcontextprotocol/sdk@1.32.2`](https://registry.npmjs.org/@modelcontextprotocol%2fsdk)
  served Claude's OAuth bridge, not central Pi execution. It initialized through
  `2025-11-25`. Registry/tarball inspection used in-memory archives only.

Installed sources: `node_modules/@earendil-works/pi-mcp/dist/{client.js,protocol/types.js}`
and `node_modules/@modelcontextprotocol/client/dist/{public-CvV4ZHkX.mjs,src-CeKsbNLO.mjs}`.
Both clients provide pagination, resources, in-memory testing and minimal auth
hooks. Official unauthorized hooks omit Pi's rejected-token argument, requiring
broker-generation adaptation. Durable's registry, codemode and replay are
independent; result mapping and schema validation belong to the execution adapter.

## Decision and implementation boundary — 2026-11-06

The user approved replacing direct `pi-mcp` execution with the existing official
client `2.4.0`, opting into modern negotiation. Local implementation uses the
standard SDK client/HTTP transport while retaining scoped Durable callables,
request-time broker credentials, cancellation and sanitized status reporting.
This is **not deployed** and does not qualify live modern provider behavior.

The direct dependency is removed. `@earendil-works/pi-coding-agent@1.5.0` still
declares `@earendil-works/pi-mcp@1.5.0`, so it remains installed transitively;
no upstream dependency patch or package upgrade is part of this change.

Retained-session alternatives were not selected: per-script clients do not span
scripts; per-conversation clients need root/child isolation and fail-closed
restart semantics; project pins bind configuration, not authorization. Modern
protocol support was chosen before adding session machinery. Per-call clients
remain; neither the SDK nor pi-orb automatically manages PostHog's application
handle. No persisted state, project configuration or prompt changes are included.

A switch acknowledgment or read in a separate legacy transport session cannot
prove a mutation's target. Stop if target scope cannot be bound to the mutation.
Modern negotiation alone does not establish cross-call application-state safety.
The current interface and qualification boundaries are in `docs/mcp.md`.

Deterministic cancellation tests held a 401-triggered broker refresh, then
cancelled the call context or closed the transport: both produced two business
POSTs instead of one (`.context/mcp-official-pr/composition-cancel-red.log`).
The scoped fetch now checks the combined cancellation signal after awaited
scope/lease checks and before network dispatch; both regressions pass without
a late retry (`.context/mcp-official-pr/composition-cancel-green.log`).

A production-composition regression then reproduced caller cancellation suppressing
legacy session DELETE. DELETE now ignores caller cancellation while retaining
fresh owner/catalog/secret/lease authorization: cancellation sends cleanup;
lease revocation blocks it. Original failure and passing checks:
`.context/mcp-official-pr/review-cleanup-{red,green}.log`.
