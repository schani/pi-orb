# Pi + mock Codex E2E

Pi inference remains real native provider serialization/stream parsing; only the OAuth and inference endpoints are test-owned. Central Durable owns the conversation and PostgreSQL state. Process and Docker hosts exercise the same execution protocol; native Claude has separate SDK contracts (`docs/claude-agent-sdk.md`).

## Supported injection

Override `openai-codex` through `ModelRuntime.registerProvider`, retaining its model definitions and wire encoder:

- custom OAuth login/refresh methods use the mock device-code/token endpoints;
- `baseUrl` directs inference to the mock Codex Responses endpoint;
- injected credential storage and `allowModelNetwork: false` prevent ambient account/configuration reads and catalog network sweeps.

Changing `baseUrl` alone does not redirect built-in OAuth: its production authorization origin is fixed. Do not monkey-patch global fetch, DNS, TLS or installed Pi files to redirect it.

The broker owns refresh tokens; scoped inference clients receive access tokens. Fake JWTs must retain the account claim expected by Codex serialization. Mock responses must be valid SSE and preserve response/item/tool-call identity; an echo server does not qualify the native stream parser.

## Fixture ownership

Each test/job owns its mock process, scenario, barriers, ports and teardown. Auxiliary Luna naming/summary calls must not consume root/child inference rules. Gate the exact operation phase through recorded requests and explicit release barriers, never elapsed sleeps. Bound every transport/body read; capture first-failure evidence before releasing/deleting fixtures.

`e2e/harness.ts` composes the real control plane, PostgreSQL or PGlite, execution provider and job-owned mock relay. `PI_ORB_E2E_BACKEND=process` selects process/PGlite; the default uses Docker/PostgreSQL. Neither selection changes Pi placement. `npm run test:e2e` drives browser login, queued messages, native model/tool turns, streamed output, settings, history and lifecycle through the real application routes.

## Required assertions

- Device approval, token refresh and rejected credentials use only mock authority; no production login/inference request.
- A tool call executes real workspace effects through an incarnation-fenced guest binding.
- Acceptance, operation ID, streamed blocks, committed history and inbox receipt identity agree.
- Abort retains cancellation through cleanup; interrupted unsafe effects are not automatically replayed.
- Stop/Start and replacement preserve private conversation authority, public history and workspace ownership.
- Browser reconnect and stopped-history reads use committed records without waking execution.
- MCP/child tests enforce authorized callback scope and keep private transcripts out of public history.

Install with `npm ci` before checks. Full runtime/harness changes require `npm run test:e2e` before deployment. Exact-source receipts, failures and exceptions live in `docs/testing.md`; a passing rerun cannot erase a failure.
