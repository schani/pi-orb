# MCP qualification helpers

## Offline checks

Run from the repository root with Node 24.6 or later:

```sh
npm ci
node --test scripts/native-mcp-exploration/live-qualification/*.test.mjs
```

Finish installation before testing. Do not install `scripts/native-mcp-exploration/` dependencies first: its unpatched SDK would shadow the root's patched SDK. These checks use the root installation and patches; synthetic providers do not qualify live accounts.

- `runner.test.mjs` exercises reusable `runQualification`, including real SDK same-session reconnect against loopback providers; its one-shot fault test uses mocked fetch. [`native-auth-retry.test.mjs`](../native-auth-retry.test.mjs) covers real SDK authorization retry. `policy.mjs` bounds approved calls and retained summaries; `fault.mjs` changes one approved request header, forwarding the actual response without fabricating a 401.
- `initial-auth.test.mjs` exercises `runInitialAuth`: initial broker denial exposes zero tools, then the next `before_agent_start` rediscovers and reads in the same SDK session.
- `owned-context-child.test.mjs` exercises the actual installed vendor child, independent discovery and restricted-profile exposure. `owned-context-worker.mjs` and `owned-context-policy.mjs` supply the approved worker profile and model-tool fence; that fence does not guard native transport fetches.
- `dependency-installer.test.mjs` verifies the sealed Pi-only installer in a clean directory outside the checkout.
- Observer tests cover bounded scope capture, real SDK context-hook wiring, measurement gates and redaction.

OAuth adapter and transport contracts:

```sh
node_modules/.bin/vitest run apps/control-plane/src/adapters/mcp-oauth.contract.test.ts apps/control-plane/src/http/mcp-oauth-routes.test.ts apps/control-plane/src/domain/mcp-oauth.dst.test.ts
node --test scripts/native-mcp-exploration/native-auth-retry.test.mjs
```

## Scope observation

`oauth-scope-measurement.mjs` wraps the first-party SDK adapter's fetch boundary for a separately reviewed exact HTTPS token endpoint. Configuration returns a typed `Result`. It passively clones at most 64 KiB/two seconds from actual exchange/refresh responses and forwards the original response unchanged. HTTP errors, OAuth errors and unusable token shapes take precedence over scope.

Retained output contains grant kind, outcome, public `mcp_all` membership and distinct unknown-scope count. Unknown names, tokens and response bodies are not retained. Omitted response `scope` is unverified; consent requests and `scopes_supported` do not establish granted scopes. Synthetic exchange/refresh contracts qualify instrumentation only. Do not inject an observer into the deployed adapter merely to force a qualification claim.

## Context observation

Add `createContextMeasurement` from `context-measurement.mjs` to an authorized session's `DefaultResourceLoader.extensionFactories`:

```js
let phase = "before_discovery";
const measurements = [];
const measurement = createContextMeasurement("root", () => phase, (record) => {
  measurements.push(record);
});
// Include measurement in DefaultResourceLoader.extensionFactories.
```

Profiles are `root`/`child`; phases are `before_discovery`, `after_discovery`, `after_search`. Labels are not discovery evidence: assert native state and authorized catalog independently. Real provider-payload hooks require authorized inference. Keep bodies and credentials in memory, retaining only bounded summaries.

`context_with_system` measures transcript JSON, excluding separately serialized tool declarations. `before_provider_request` measures provider-payload JSON. Both report UTF-8 bytes/codepoints, not tokenizer estimates or exact model tokens. `activeMcpToolCount` excludes approved deferred/codemode tools that are not active. Manual hook tests prove wiring, not authenticated discovery or inference; the context wiring test also invokes the root-installed SDK hooks.

`owned-context-observer.mjs` checks Sol completion, per-profile exposed-tool inventory, codemode activation, payload phase and denied model calls. Exposed tools are the public SDK registry, not upstream discovery counts. Independent empty-catalog baselines are not same-session pre-discovery measurements; explicit-child results do not qualify the default general-purpose profile.

## Live acceptance boundary

Live work requires explicit authorization of accounts, connections, reads and inference. Use the guest's own runtime broker/project-secret service; never copy credentials elsewhere or replace its deployed SDK. Record the executed source/bundle/lock/patch hashes and sanitized outcomes, distinguishing MCP success, application success and truncation. Preserve first failures before cleanup.

Verify provider-supported revocation and affected clients before destructive action. Project separation, browser Disconnect and project deletion do not prove upstream grant isolation or revocation. Distinguish upstream-service tool failure, MCP auth denial and refresh denial; only captured refresh `invalid_grant` establishes that code. Do not guess endpoints or infer isolation from application names.

For IAP continuation, preserve the OAuth nonce and pending-consent deadline; retain sanitized path/status/outcome only, never callback query strings or cookies. Removing an IAP cookie is not natural expiry or a password/MFA challenge. Local nonce/replay tests do not qualify Google's continuation behavior.

Native-browser helpers and their separate transport/authority limits: `native-browser-README.md`.

Historical live results, immutable artifact identities, first failures and cleanup:

- `docs/postmortems/2026-09-30-native-mcp-qualification.md`
- `docs/postmortems/2026-10-01-mcp-measurement-fixtures.md`

Current provider acceptance scope: `TODO.md`. Qualification history: `docs/testing.md`. Historical Pi 0.99.1 results do not qualify the root's Pi 1.1.0 installation.
