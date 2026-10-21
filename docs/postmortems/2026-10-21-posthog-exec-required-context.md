# PostHog exec requires context and model

## Finding — 2026-10-21, PDT

Orb `377b20ee-849f-404d-ad76-eb57596a6b66` submitted PostHog `exec`
with only `command`. The connected service's live schema also requires
`context` and `llm_model`. A command-only object is invalid; this is not
evidence of broken PostHog authentication.

The serving control-plane revision was `pi-orb-issuer-00068-xfw`, image digest
`sha256:3a3b1cea0c3d40c735e5a617623601e03401eda27ac8541badd291355c8be8c2`.
Cloud Run revision metadata independently confirmed the digest.

## Evidence

Read-only PostgreSQL transactions selected the target orb's PostHog binding
and persisted nested tool tasks. The binding uses static project-secret
headers, not MCP OAuth. Exact referenced credential material was resolved
in memory; no values were printed or written to files. Existing GCP access
sufficed; no grants, PostHog token exchanges/refreshes, or application-state
changes were made.

Authenticated `initialize` and `tools/list` returned one tool, `exec`, with
no pagination. Its schema, omitting descriptions only:

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string" },
    "context": { "type": "string" },
    "llm_model": { "type": "string" },
    "conversation_id": { "type": "string" }
  },
  "required": ["command", "context", "llm_model"]
}
```

The descriptions request abstract third-person context in 15–25 words,
the exact model identifier or `unknown`, and an unchanged server-issued
conversation ID when available. These are description instructions, not
additional JSON Schema constraints.

- Persisted nested task `32630` had argument keys `["command"]`.
- TypeBox `Check` against the freshly fetched full schema returned **false**
  for that task's original arguments: missing `context` and `llm_model`.
- Adding those two strings to the same arguments returned **true**.
- At **4:00:27 PM PDT**, authenticated `tools/call` of `exec` with `command:
  "help"`, `llm_model: "unknown"`, and the following 20-word context succeeded:
  no JSON-RPC error, `isError: false`, one text block of 439 characters.
  Response contents were suppressed.

> The developer is diagnosing a rejected MCP invocation to determine the required argument fields without accessing or modifying product data.

Only the informational help command was executed; no product-data operation
was requested. No implementation change or deployment was needed for that live
qualification.

## Limits and diagnostic rule

The transcript exposed `exec(args: unknown)`, hiding these required fields.
The declaration renderer's default 16,000-character input limit includes
property descriptions; oversized declarations become `unknown`. The live
schema includes roughly 40 KB of descriptions. Separately,
`apps/control-plane/src/adapters/durable/tools/codemode.ts` replaces
`invalid_arguments` diagnostics with a generic tool-name error, hiding
missing-field details.

The running agent's discovery-time schema is cached in process memory and
was not retrieved. Live `tools/list` proves the current remote contract,
not the exact historical cached schema or which validation layer rejected
each earlier call.

The original native diagnostic could not be recovered: task `32630` maps to
`pi.tool.nested-call` document `32629` (parent `32626`, key `c1`), but that
retired document has zero retained revisions. The other thirteen persisted
PostHog exec tasks likewise had no matching document revisions. Task records
retain inputs, not the original nested result diagnostics.

Inspect the authenticated schema of the connected service before reducing
an argument-validation failure to an authentication or transport problem.
Rendered declarations and public examples can omit or differ from required
live fields; distinguish live discovery from historical process-cache evidence.

## Correction — 2026-10-21 (local, not deployed)

The sealed codemode patch retries declaration rendering without descriptions
after the existing tag-free pass. Types, local references, requiredness and
limits are preserved; semantic comment guidance is absent on this fallback.
Structurally oversized declarations still become `unknown`. Validation uses
the original schema.

The native `invalid_arguments` sanitizer now recomputes only missing top-level
required names from the visible callable catalog. Names are quoted and bounded;
argument values and original diagnostic text remain excluded. Other invalid
arguments retain the generic rejection. No persisted-state or validation-order
changes.

Tests first reproduced `exec(args: unknown)` and the generic command-only
rejection. Renderer regressions cover normal comments/tags, local references,
requiredness and the structural cap. The in-memory MCP/native codemode fixture
then proves discovery of all four fields, safe missing-name output without
argument secrets, no invalid-call effects, and successful corrected execution.
These tests do not qualify a deployment or change the historical evidence limits.
