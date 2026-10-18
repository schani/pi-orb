# Native MCP characterization receipts

Historical Pi 0.99.1 evidence on Node 24.6.0, not current SDK, central code-mode, browser, live-account or deployment qualification. Live provider/measurement evidence remains in `docs/postmortems/2026-09-30-native-mcp-qualification.md` and `docs/postmortems/2026-10-01-mcp-measurement-fixtures.md`; current contracts are in `docs/mcp.md` and `docs/testing.md`.

## Isolated qualification

The locked standalone suite passed **27/27, zero skipped** in approximately 17.1 seconds, including seven low-level auth-retry and five embedded-session cases. The production history-mapper baseline passed **32/32**; scoped lint passed for twelve exploration files. Synthetic models/token endpoints and loopback JSON-RPC supplied all inference/auth/transport; no provider credentials were used.

- Native invalid-session 404 recovery produced **two attempts, two initializations, one accepted write** only with the coding-agent's own `pi-mcp` constructor identity. The duplicate installed module produced **one attempt, one initialization, zero accepted writes** because `McpSessionExpiredError` failed native `instanceof`. Accepted writes with lost responses were not replayed. [Original module-identity failure](../../scripts/native-mcp-exploration/evidence/transport-failure-evidence.tap).
- The real runtime credential resolver reused cached grants, renewed within its 30-second expiry window, rejected exact generations and recovered on the next explicit call. A low-level native auth-hook fixture retried a 401 once with a newer grant, then stopped after a second 401. Challenged `403 insufficient_scope` retried once without broker rejection/escalation; ordinary 403 did not. Cancellation during credential resolution sent no POST. These were not full session-extension or production refresh/consent proofs.
- Embedded code-mode discovery persisted `codemode-store` and bounded `nestedCalls` through JSONL reload; the mapper retained nested summaries only in native overflow, not a typed hierarchy. Separate root/child sessions initialized distinct MCP IDs; child DELETE left the root usable without reinitialization (**two initializations, three calls**). Abort persisted a failed parent result before the held server response; awaited runtime shutdown closed connections and prevented late initialization.
- Startup HTTP failure had no durable native-entry diagnostic. UI notification was source-reviewed, not captured. Custom-message preflight and Codex diagnostic integration were not qualified by these released-package tests. Catalog assertions for image/reasoning metadata and standalone code-mode without MCP were characterization, not product cutover evidence.

## Original first-failure files

These files preserve original bytes from the removed exploration tree; paths inside them identify historical fixtures, not runnable current commands.

- [Missing embedded fixture](../../scripts/native-mcp-exploration/evidence/embedded-first-red.tap); [incorrect `codemode-store` assertion](../../scripts/native-mcp-exploration/evidence/embedded-review-red.tap).
- [Unawaited discovery](../../scripts/native-mcp-exploration/evidence/first-script-failure.json); [activation before startup](../../scripts/native-mcp-exploration/evidence/failure-runtime-refactor.json); [abort/cleanup fixture](../../scripts/native-mcp-exploration/evidence/failure-cancel.json); [response mistaken for initialized connection](../../scripts/native-mcp-exploration/evidence/failure-startup.json).
- [Resolver port adaptation](../../scripts/native-mcp-exploration/evidence/resolver-red-first.tap); [transport before implementation](../../scripts/native-mcp-exploration/evidence/transport-red-first.tap); [resource pagination fixture](../../scripts/native-mcp-exploration/evidence/transport-red-resources.tap).

The corrected embedded fixture distinguished `notifications/initialized` from an HTTP response and used runtime disposal rather than plain session disposal for shutdown hooks. Passing characterization retained known gaps; it did not convert them into guarantees.
