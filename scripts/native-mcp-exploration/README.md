# Native MCP exploration

Isolated Pi 0.99.1 integration characterization, not a production upgrade. Node **24.6.0** was tested. No live inference, provider credentials, production SDK cutover or deployment.

```sh
npm ci
npm ci --prefix scripts/native-mcp-exploration --ignore-scripts
npm test --prefix scripts/native-mcp-exploration
```

Install root dependencies: the fixtures import the production history mapper and credential resolver. The exploration package runs Node with `--import tsx --experimental-import-meta-resolve --test --test-timeout=60000`. After the clean isolated install and added auth-retry/always-on tests, the combined suite passed **27/27, 0 skipped** (~17.1 s); the production mapper baseline passed **32/32** (`npx vitest run apps/orb-runtime/src/pi/mapping.test.ts`). Scoped Biome checks passed for twelve exploration files; production code was unchanged.

## Findings

- Native `loadConfig` accepts an injected catalog snapshot; `createTransport` accepts a transport with a custom per-request fetch. Real `McpCredentialResolver`, with a fake token endpoint, demonstrated cache, expiry-window renewal, rejected-generation 401 handling and recovery on the next explicit call. The exploratory fetch adapter sends static headers on GET and POST, redacts error bodies and disables redirects. No production control-plane OAuth refresh provider was exercised.
- A rejected invalid-session 404 causes one native reinitialize and retry: **2 attempts, 2 initializes, 1 accepted write**. An extra installed `pi-mcp` module identity instead gives **1 attempt, 1 initialize, 0 accepted writes** because the exception class differs. Resolve the transport constructor through the public parent-URL ESM resolver or a narrow upstream packaging fix. An accepted write with a lost response is not retried through the real native extension; do not add a custom retry policy.
- A minimal native `AuthProvider` enables Pi's bounded authorization retry while request-time fetch keeps broker resolution cancellable. A 401 retries once with a newer grant; repeated 401 stops after two attempts. Preserving the challenge header retains native `403 insufficient_scope` handling; ordinary 403 is not retried. No guest consent, token file or custom retry loop. These are native transport/client tests, not full extension-session auth tests.
- Low-level client resource pagination, templates and reads work. Embedded codemode discovery stores results in `codemode-store`; nested call summaries survive JSONL reload through the production history mapper, but its typed projection lacks nesting. Aborted calls and late-startup shutdown are covered.
- Independent root/child sessions get distinct MCP session IDs. Deleting the child's connection leaves the root's original connection usable; prefer simple per-session connections to a sharing hack. Startup failure appears at the transport but has no durable diagnostic in native entries; UI notification behavior was source-reviewed only. Preserve sanitized host failure edges and user-visible outcomes. The local custom-message preflight fix is still missing upstream; Codex diagnostic hooks were only source-audited.
- Codemode executes without any MCP extension/catalog in independent root and child-style SDK sessions. Always-on production composition is approved, not implemented (`docs/pi-adapter.md`, `TODO.md`).
- The isolated Pi catalog tests verify `gpt-6.1-sol` for `openai` and `openai-codex`, including image/reasoning metadata; this does not qualify runtime/model UI cutover (`docs/agent-settings.md`, `TODO.md`).

See [`transport-evidence.md`](transport-evidence.md), [`native-auth-retry-evidence.md`](native-auth-retry-evidence.md) and [`embedded-history-evidence.md`](embedded-history-evidence.md); retained first failures are in [`evidence/`](evidence/). Passing characterization tests also encode **gaps**, including duplicate-module class identity, custom messages skipping preflight and missing typed nesting; 27 passing tests are not 27 production guarantees. This is not browser E2E, a full patched-runtime upgrade, subagent fork qualification or live provider/account testing. Native prompt exposure remains absent; the current GlideOS catalog returned no prompts (`docs/mcp.md`).
