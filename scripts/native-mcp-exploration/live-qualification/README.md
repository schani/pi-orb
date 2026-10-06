# Live MCP qualification

Local tests, Node 24.6:

```sh
npm ci
node --test scripts/native-mcp-exploration/live-qualification/*.test.mjs
```

Finish installation before testing. Node's TypeScript support is sufficient; no root `tsx` loader is needed.

Build the corrected, provenance-checked guest package (no cloud calls):

```sh
node scripts/native-mcp-exploration/live-qualification/stage-package.mjs .context/dedicated-oauth-reauthorization/new-output
```

The output directory must not exist. The helper copies current root patches, bundles first-party protocol code, then installs and runs the archive's own `preflight.mjs` in a fresh directory outside the checkout. In the guest, verify the archive hash, extract into an isolated directory, run `npm ci --ignore-scripts`, apply its patches with `node apply-dependency-patches.mjs --pi-only`, then run `node preflight.mjs` from the extracted `staging/` directory. Inspect the output's `staging/manifest.json`, `preflight.json`, logs and `guest-stage.tgz` before upload. Do not copy a prior stage or its `node_modules`.

Offline context-hook wiring: `node --test scripts/native-mcp-exploration/live-qualification/context-measurement.test.mjs`. To measure a real Pi session, add `{ name: "qualification:context", factory: createContextMeasurement("root", () => phase, record => summaries.push(record)) }` to that session's `DefaultResourceLoader.extensionFactories`; use `"child"` for an independent child session. Set `phase` only to `before_discovery`, `after_discovery`, or `after_search`. Keep summaries in memory; emit only the helper's bounded records, never raw context, payload, tools, or credentials. The transcript metric excludes separately serialized provider tool declarations; `activeMcpToolCount` excludes approved deferred/codemode tools. The payload metric needs a real model request. Neither metric is an exact model-token count. The offline fixture manually emits SDK hooks and proves neither authenticated discovery nor inference.

The live runner is a bounded diagnostic, not a general MCP client. It checks the expected orb identity and dedicated catalog revision 1 (Cloudflare and Datadog OAuth IDs/URLs), and permits only exact approved server/tool/argument combinations. `reject-read` arms a one-shot invalid bearer only after obtaining a real grant; the provider's 401 and Pi's native retry are observed, not fabricated. `reconnect` invokes Pi's public command within the same SDK session; it does not test application command routing.

Run it inside an explicitly authorized diagnostic orb:

- Bundle the production adapter from the target source tree.
- Use this directory's lockfile and matching SDK patches in an isolated guest directory. Do not replace the deployed SDK.
- Use the guest's own runtime broker and project-secret service. Never copy credentials elsewhere.
- Record source, bundle and lock hashes; distinguish MCP success, application success and truncated results.
- Remove the owned directory and stop the fixture afterward.

Evidence must name the bundle actually executed, not a later rebuild.

Offline OAuth checks (no cloud credentials, grants or servers):

```sh
node --test scripts/native-mcp-exploration/live-qualification/oauth-scope-measurement.test.mjs
node_modules/.bin/vitest run apps/control-plane/src/adapters/mcp-oauth.contract.test.ts apps/control-plane/src/http/mcp-oauth-routes.test.ts apps/control-plane/src/domain/mcp-oauth.dst.test.ts
node --test scripts/native-mcp-exploration/native-auth-retry.test.mjs
```

`oauth-scope-measurement.mjs` wraps the first-party SDK adapter's fetch boundary for a separately reviewed exact HTTPS token endpoint. Its factory returns a typed `Result` for configuration validation. Once configured, it passively clones at most 64 KiB/2 seconds from **actual exchange/refresh responses**, emits only grant kind, outcome, known public `mcp_all` membership and unknown-scope count, and forwards the original response unchanged. HTTP errors, OAuth error objects and unusable token shapes take precedence over scope. Only Datadog's public `mcp_all` name is identified; Cloudflare scopes remain unknown counts, **not** an inventory. The adapter contract invokes the wrapper for both exchange and refresh; synthetic responses prove instrumentation, **not provider-granted scope**. Omitted token-response `scope` is unverified even if discovery or the consent request advertises it. Do not store raw token responses or inject the observer into the deployed adapter solely to force a qualification claim. On 2026-10-01, both real refresh responses exceeded the original 4 KiB observation budget; normal broker publication succeeded. The observer now allows 64 KiB, below the adapter's existing 1 MiB response bound, with the same deadline and tested large-token redaction. Publication and scope observation are reported independently.

Live acceptance remains separate from instrumentation tests. On 2026-10-01, human IAP-cookie-removal continuation and provider-UI revocation/reconnection passed for both providers; exact scopes and limits are in `docs/mcp.md`. Natural refreshes at 22:33 UTC captured actual response scopes: Cloudflare 384 distinct unknown names, Datadog 164, neither including `mcp_all`; no unknown names were retained. Earlier captures failed observer limits, not broker publication. The corrected authenticated root/explicit-child context gate also passed with real Sol at 22:39–22:40 UTC; payload sizes and independent-baseline limits are recorded in `docs/mcp.md`. The failed general-purpose and earlier wrapper runs retain their original outcomes. The subsequent default-policy fix is covered by actual vendor-child regressions; the earlier live archive does not qualify that change.

- Upstream revocation: verify the provider-supported operation and its affected clients before any destructive action. A dedicated pi-orb project does not prove grant isolation; shared authorization changes require explicit approval. Browser Disconnect and project deletion are **not** upstream revocation. Record the observed failure layer: upstream-service tool error, MCP authentication denial, or token refresh denial. Only a captured refresh `invalid_grant` establishes that specific error. The 2026-10-01 Cloudflare application revocation left MCP discovery/broker authorization intact while the tool failed; requiring broker `invalid_grant` for that different authorization layer would conflate two grants. Datadog's shared-client revocation produced `needs-auth`/`auth_required`, without a captured provider error code. Do not guess endpoints or infer revocation scope from application names.
- Expired-IAP consent continuation: start legitimate OAuth consent on a dedicated connection. Before the provider returns, require IAP reauthentication while preserving pi-orb's OAuth nonce cookie and staying within the pending consent deadline. Follow the actual provider callback and IAP login in the same browser; verify the intended connection becomes connected and an approved read succeeds. Record only sanitized path/status and outcome evidence, never callback query strings or cookies. Distinguish actual session expiry from removing an IAP cookie; clearing all application cookies destroys the OAuth nonce and tests a different failure. If this cannot be arranged without changing production policy or bypassing identity, record blocked. Local nonce/replay tests do not qualify Google's continuation behavior.
- Granted scopes: observe an actual provider **token response** through the bounded wrapper during a legitimate new consent or refresh. `scopes_supported` and requested scopes are not evidence. Unknown scopes are counted, not recorded verbatim. Use an explicitly approved fixture; do not reuse unrelated connections or assume project separation isolates provider grants.

## Owned-grant refresh and real SDK context

`owned-refresh.ts CF|DD <GCP project> <database-secret-name> <exact-version> <credential-prefix> <app-origin>/api/v1/mcp/oauth/callback` is an operator-process probe for project `4661f85f-e70f-4ccd-b50d-2524496cb02a` only. Review the target DB secret, endpoint, callback and currently expired pointer before execution. The owned fixture was deleted on 2026-10-01 after qualification; its immutable results are recorded in `docs/mcp.md`. Its hard-coded ownership fence intentionally cannot target another project. A future fixture requires separate approval and reviewed identifiers. Its separate read-only PostgreSQL preflight checks the exact project/catalog binding and exact GSM credential version; the mutable phase rechecks them and invokes `McpOAuth.token({reason:"startup"})` once. Only the domain's lease/CAS may write. If a grant is unexpired or leased, it skips; do not force expiry/401 or invoke the refresher directly. `SdkMcpOAuth` receives the response observer at its constructor fetch boundary. Output contains only outcome, approved scope names/count, and generation; omitted scope is unverified. Execution requires explicit parent review. No service is deployed.

`owned-context.ts <expected-diagnostic-orb-id>` is a separate guest-only probe: it fetches its own workload identity and first-party model/MCP broker grants, starts an independent **empty-catalog** baseline (not pre-discovery within the approved session), then native approved discovery on root and a real vendor-fork child using Sol 6.1. Root alone invokes Pi's public native `tool_search` definition with exactly `cloudflare account` and `datadog monitor` outside inference, checks nonempty namespace-specific results, and records the subsequent real provider payload as `after_search`. The probe creates a private `owned-context-worker` using exactly the root SDK's approved 3/33 MCP names plus codemode. It builds that allowlist in a separate bounded real SDK preview turn before the measured root session; the baseline worker allows codemode only. The authenticated child must expose 3/33 and measure `after_discovery`, with **zero searches**. Both empty-catalog baseline sessions measure `before_discovery`; no child after-search measurement is claimed. All four sessions retain always-on codemode; root explicitly activates it after binding, and the vendor child factory activates it for children. It emits JSON bytes/codepoints from real SDK hooks, not token counts, prompts, payloads or provider records. Accepted provider payloads require each authenticated root and worker child's own observed 3/33 exposed-tool inventory, zero exposed tools in the independent baseline, and Sol model selection. `exposedToolCount` is the SDK's public per-profile tool registry, **not** the upstream MCP discovery inventory. A completed assistant stop and zero denied model calls are required; a resolved prompt or completed child status alone is insufficient. All model tool calls are blocked. Root-only native SDK search results are inspected in memory without emitting synthetic SDK hooks or retaining raw tool results; native transport fetches remain outside the model tool fence. The diagnostic orb must already own the test project; do not install a deployed SDK or move model credentials into env/files outside its private SDK auth path. Source/tests require review and validation before any guest run.

## Context measurement

Add `createContextMeasurement` from `context-measurement.mjs` to an authorized diagnostic session's existing extension factories:

```js
let phase = "before_discovery";
const measurements = [];
const measurement = createContextMeasurement("root", () => phase, (record) => {
  measurements.push(record);
});
// Include measurement in DefaultResourceLoader.extensionFactories.
```

Profiles are `root`/`child`; phases are `before_discovery`, `after_discovery`, `after_search`. A label is not discovery evidence: assert actual native state and authorized catalog separately before changing it. Real hooks require a model turn; obtain inference authorization first. Keep bodies and credentials in memory, retaining only the observer's summaries.

`context_with_system` measures transcript JSON, not separately serialized tool declarations. `before_provider_request` measures the provider payload. Both report UTF-8 bytes/codepoints, not tokenizer estimates or exact model tokens. `activeMcpToolCount` excludes approved deferred/codemode tools that are not active. The fixture manually emits SDK hooks; it tests wiring and redaction, not authenticated discovery or an actual request. Run it with `node --test scripts/native-mcp-exploration/live-qualification/context-measurement.test.mjs`.

Results and limits: `docs/postmortems/2026-09-30-native-mcp-qualification.md` and `docs/testing.md`.
