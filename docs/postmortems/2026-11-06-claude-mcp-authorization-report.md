# Claude MCP authorization report: evidence gap

2026-11-06; November times PST. Native Claude orb `3e945c80-7f15-41be-bb7e-5656cba43fd0`, project GlideOS g3.

## Finding

The agent repeatedly reported that Datadog required authentication and recommended `/mcp`. The retained public history does not establish an authentication failure. Native MCP startup status is not captured by the current runtime integration; a stored OAuth grant does not establish upstream MCP access either. The historical native status and effective server source remain unknown. No authorization or configuration-collision root cause is established.

## Read-only evidence

- The target was created November 5 at 11:45 with checkout `04d7535c0299d34d0631b37e006f28c528e67c3e`.
- All 733 committed public records were inspected. They contain repeated Datadog authorization claims, including November 6 at 09:27:58, but no Datadog tool search, call or error. Cloudflare calls succeeded at approximately 10:14.
- Production inspection used a read-only SQL transaction. Project catalog revision 7, unchanged since October 23, configures OAuth servers named `cloudflare`, `datadog`, `glideos` and `posthog`.
- The Datadog broker grant was current, with `refreshPresent: true`. Generations 547, 548 and 549 refreshed November 6 at 09:00:08, 10:00:11 and 11:00:08 respectively; no invalidation was found during that interval. These are project-wide refreshes, not evidence of this orb invoking Datadog or successfully accessing its MCP endpoint.
- An access-token-authenticated `GET /api/v1/projects/:projectId/mcp` returned 401. Orb access tokens are not browser API authentication; that response is not a Datadog authorization failure.
- The target stayed stopped. No production writes, reconnects, consent flows or tool probes were performed.

## Repository configuration

Authorized GitHub reads at the [exact checkout](https://github.com/glideapps/g3/blob/04d7535c0299d34d0631b37e006f28c528e67c3e/.mcp.json) confirm a second `datadog` definition: native HTTP with `headersHelper: "./.claude/mcp-headers.sh"`. The helper reads `DATADOG_API_KEY` and `DATADOG_APP_KEY` from `.dev.vars`, emitting `DD-API-KEY` and `DD-APPLICATION-KEY`. No secret values or helper output were inspected. The helper blob is `a9cb829b8d6e0d81b9505040aeb3e87cbb64a249`.

The checkout also defines `posthog` and `cloudflare-observability-prod` / `cloudflare-observability-sandbox`; the latter names differ from the OAuth catalog's `cloudflare`. Its `.claude/settings.json` contains hooks, not MCP overrides. Repository Datadog troubleshooting describes native static-key failures, but is not incident evidence.

The runtime supplies OAuth entries as SDK in-process servers, enables `settingSources: ["user", "project", "local"]`, and does not set `strictMcpConfig`. Names therefore overlap, but effective precedence was not established. Neither shadowing nor execution of the repository helper is proved.

## Observability boundary

Inspected source: `apps/orb-runtime/src/claude/agent.ts`, `apps/orb-runtime/src/claude/history.ts`, `apps/orb-runtime/src/claude/mcp.ts`; local revision `51174eb277235e2c33d23d263010f631e23e679a`, SDK 0.3.318. This source inspection does not independently identify the target's deployed runtime revision.

The SDK's `system/init` includes `mcp_servers` names, statuses and optional sources. Its public `mcpServerStatus()` exposes status/source/scope metadata. The runtime ignores init MCP status and never calls that method. Generic system-history mapping retains only native type/UUID, not MCP status details. Configured OAuth bridge transport diagnostics publish safe `claude.mcp` edges; ambient native repository HTTP connections do not traverse that bridge.

Thus absent public tool errors cannot exclude a startup/discovery failure. Conversely, agent prose cannot establish one. The supported outcome is an observability gap, not a proved invalid grant, provider failure or name-collision defect.

## Local candidate diagnostics

The local candidate adds sanitized per-turn native status/source and independent OAuth bridge edges in root history (`docs/mcp.md`). It is not deployed and cannot reconstruct historical status or precedence. Prompts/configuration are unchanged. Focused local checks are not E2E/provider/deployment qualification; the voluntarily cancelled broad unit run is partial evidence only.
