# Credentials

How orbs obtain model, GitHub and Claude credentials and project secrets without holding a
renewable credential. Application login and ownership: `docs/auth.md`. Orb OIDC identity:
`docs/workload-identity.md`.

## Principles

- Renewable credentials (refresh tokens, OAuth client secrets) never leave the control plane.
- Orbs get short-lived access tokens at point of use from the broker.
- Never bake secrets into images, instance metadata, project volumes, PostgreSQL, history, logs or
  browser responses.
- Prefer workload identity or capability-specific broker grants over forwarding developer
  credentials.
- Setup hooks and project-local agent extensions are executable, trusted repository code.
- Accepted exposure: repository code in an orb can read its runtime bearer and so obtain that
  owner's short-lived tokens while the orb runs. It can never obtain a refresh token.

## Runtime incarnation bearer

A 256-bit random token minted per host incarnation, read-back model:

- The provider mints only when it actually creates a container, VM or process host and injects the
  token into that host's private channel (`--env` on Docker, instance metadata on GCE, mode-0600
  provider metadata plus child env on the process provider). Finding an existing host, it reads the
  token back instead of re-minting.
- `provision` returns the SHA-256 of the token the host actually carries; the control plane commits
  that hash with the host ref by state-version CAS. Concurrent provisions observe one host and one
  hash; a replaced host is detected by hash, not just ref. Rejected: committing a hash before
  create, which let a stale provisioner leave a host nobody could match.
- GCE restart-in-place keeps the incarnation and token; replacing a container or VM rotates it.
- The runtime receives `PI_ORB_CONTROL_PLANE_URL` and `PI_ORB_RUNTIME_TOKEN`; this env contract is
  provider-neutral.
- Lookup is by indexed hash with constant-time comparison. A bearer hash is not an OAuth credential.
- A host can run before its hash commits; boot-time 401s are retried for a bounded period, with the
  readiness deadline as backstop.

The bearer authorizes only `/runtime/...`, `/api/runtime/initial-checkout` and
`/api/runtime/alert`, and only while the orb's state is in `RUNTIME_TOKEN_STATES`: `creating`,
`starting`, `running`, `stopping`, `archiving` (archive may restore a runtime to seal its
transcript). Stopped and failed callers are refused. Routes act for the authenticated orb and
accept no caller-supplied source identity, except the deliberate company-trust reads and
same-owner actions in `docs/control-plane-api.md` and `docs/inbox.md`. One orb can never mint
another orb's workload identity, mutate an existing sibling's lifecycle or obtain its bearer.

On the shared local Docker network, orb containers can reach the whole control plane over
plaintext. Accepted for trusted single-machine development; close it with a separate broker
listener or network if that changes.

## Broker

The control plane owns every renewable credential: it runs device logins, performs every upstream
refresh and holds the only durable refresh token. Code: `apps/control-plane/src/domain/broker.ts`,
`http/runtime-routes.ts`, runtime client `apps/orb-runtime/src/domain/broker-client.ts`. Rejected:
mounting `auth.json` into orbs or moving it to Secret Manager, because either way the refresh token
lands in an orb running untrusted code.

### Runtime token route

```text
POST /runtime/v1/tokens/{name}        name ∈ "model" | "github"
Authorization: Bearer <runtime bearer>

request  { "reason": "startup" | "expiring" | "rejected", "staleGeneration"?: number }
200      { "accessToken": string, "accountId"?: string, "expiresAt": number, "generation": number }
         // expiresAt ms since epoch; Cache-Control: no-store
         // accountId: account ID for model, GitHub login for github
401      unknown, invalid or lifecycle-revoked bearer
404      { "error": "unknown_token" }
409      { "error": "auth_required" }
429/5xx  retryable; the runtime backs off with jitter and honors Retry-After
503      store unavailable (never folded into 401)
```

`{name}` is a logical capability; `TOKEN_PROVIDERS` maps `model → openai-codex` and
`github → github`, so a provider change never touches the runtime contract. Schemas:
`packages/protocol/src/broker.ts`. The route authenticates the incarnation, resolves
`orb → project → owner`, binds the broker to that owner and accepts no user selector.

`generation` identifies the stored credential. The runtime echoes it as `staleGeneration` when
reporting an expiring or rejected token; the broker refreshes upstream only if it still matches,
otherwise it serves the newer token. Rejected: a client timestamp fingerprint, which is not unique
and lets an orb force rotation. Upstream refreshes are also limited to one per 30 seconds per
user/provider unless the token is expired, and the broker refreshes proactively below 5 minutes of
remaining lifetime.

### Storage and fencing

- Secret Manager (file store locally, `broker-secrets/`) holds payloads; PostgreSQL
  `credential_pointers` rows keyed `(user_id, provider)` hold `{generation, secretVersion}`.
  Readers use exact versions, never `latest`.
- Every login, refresh and invalidation names the generation/row version it read and commits by
  pointer CAS. A short per-user/provider lease coalesces refreshes; no database lock spans an
  external call, and a crashed holder times out.
- `CredentialPointerStoreFactory.forUser(userId)` binds the generic pointer interface;
  `bindUserBroker` combines it with shared secret storage, provider clients and constants. Pointer
  CAS, leases, login gates, flows, challenges and blocked cohorts are per user, so users never
  serialize behind or fail each other. Provider parents and client configuration are shared.
- Cleanup destroys only exact versions known to be superseded or definitely unpublished; it never
  enumerates a provider parent. File-secret writes use exclusive creation.
- After a non-conflict CAS error, an exact pointer reread may prove the write committed; otherwise
  publication returns `login_commit_uncertain`, drops the staged material and re-resolves next
  time. It never retries an uncertain version. A known pre-commit failure keeps the material for
  retry.

**Loss window.** Upstream refresh rotates the refresh token, and acceptance plus durable storage
cannot be atomic. Loss between them forces re-login (`auth_required`), never silent corruption.
After a pointer-write error or conflict the writer rereads: its published version succeeds; the
same generation and old secret permit another CAS at the reread row version, even across a
replacement lease; a newer generation or different secret wins
(`docs/postmortems/2026-09-17-broker-refresh-publication-retry.md`).

**Failure semantics.** Transient upstream or storage failures while the current access token is
valid serve that token and retry refresh later. Only an expired or rejected token plus a failing
refresh is an error. `invalid_grant` clears only that user's generation; later calls return
`auth_required`. A revoked credential fails the active operation with a typed error; recovery is
stop/start. A standalone re-login action is a `TODO.md` item.

**Caller admission.** Request-owned callers (activity headlines) pass a signal and monotonic
`deadlineAt` into `getToken`; the broker checks it before and after pointer/secret reads and lease
acquisition, so a stopped caller never receives a grant. An already-admitted rotating refresh still
settles under the broker's own budget: persist, publish by CAS or follow supersession/uncertainty
rules, retire exact versions. Cancelling that would lose the only valid refresh token. Stopped-caller
settlement emits content-free `credential.rotation_settled`.

**401 policy.** Pi has no 401-triggered refresh. A revoked-but-unexpired token fails without
refresh; partial streams and tools are never replayed. `"rejected"` is reserved for a future SDK
hook.

### Runtime client

Startup and refresh budgets are 60 s and 30 s, covering I/O, backoff and `Retry-After`; each HTTP
request has its own 30 s budget and reads status before any error body. Results are typed
cancellation/network/status outcomes. Coalesced callers cancel independently; the last cancelled
waiter aborts shared I/O and waits for cleanup, and a replacement caller waits for the abandoned
flight to drain. No cancelled or expired flight publishes a grant.

### Central inference

`createDurableModels` registers only `openaiCodexProvider()` in an empty pi-ai `createModels()`
collection. Its `auth.apiKey.resolve({signal})` asks the owner-bound broker on every resolution; no
ambient provider, auth file, environment credential or caller key bypasses it. Resolved
`auth.baseUrl` overrides the inference endpoint for native and auxiliary Luna calls. Root and child
requests share the owner's collection with independent signals. A grant returned after cancellation
is rejected. Fake inference changes only the base URL.

### Abuse bounds

Per-orb token-endpoint rate limits, the refresh floor and Cloud Run's instance cap bound
amplification. No quotas or adversarial-tenant boundary.

## Device login (Codex and GitHub)

There is no frontend auth API. Login is a prerequisite inside orb create/start:

1. Before host work, the control plane resolves the harness's model credential (Codex for Pi,
   the Claude connection for Claude) then GitHub through the project owner's broker
   (`getToken(..., "startup")`). Usable or refreshed credentials need no ceremony.
2. Otherwise the orb stays durable `creating`/`starting` and one device flow starts for that
   owner. `CompositeAuthGate` chains model → GitHub so the owner sees one challenge at a time.
3. The owner's `OrbView.actionRequired` carries verification URI, user code and expiry. Coworkers
   and ops see only `{type: "owner_login_required", provider}`. The browser just polls the orb.
4. Publication wakes only that owner's blocked cohort. Known expiry or denial fails only that
   cohort with a typed error; storage, upstream, publication and opaque SDK failures stay retryable.

`SerializedAuthGate` singleflight is keyed by owner and harness. Flows, challenges and cohorts are in memory;
each orb's intent is durable. After restart, reconciliation resolves canonical broker state before
opening a fresh flow. Lifecycle edges `auth-blocked`, `auth-resolved`, `auth-failed` carry owner
UUID and provider, never codes, URLs or tokens. Browser response schemas reject `access`/`refresh`.

### OpenAI Codex

Pi's built-in `openai-codex` provider with a ChatGPT subscription, no API key. Stored shape:

```ts
interface StoredCodexCredential {
  type: "oauth";
  access: string;
  refresh: string; // the durable secret
  expires: number;
  accountId: string;
}
```

Login uses `ModelRuntime.login("openai-codex", "oauth", interaction)` with Pi's headless
`device_code` method, a fresh `ModelRuntime` per ceremony. The SDK artifact
`<PI_ORB_AUTH_DIR>/users/<user UUID>/auth.json` exists only to publish a just-completed login; it
is never authority or a read fallback. No shared `auth.json` import: a stale file could resurrect a
credential after `invalid_grant`. Process loss between SDK completion and publication may require
login again.

SDK boundary: `CredentialSynchronizationError` guarantees committed credentials, so the gate
publishes them. Other SDK rejections retry unless the challenge expired; English-message
classification is rejected and only safe stage messages surface. Starting a login returns a
preparing state; the challenge appears on the next five-second lifecycle poll. A flow stays
tracked until the SDK operation ends, so one owner never runs overlapping logins.

Codex also backs auxiliary Luna calls (naming, summaries, headlines) for the project owner
(`docs/control-plane-api.md`, `docs/activity-headlines.md`). Model selection:
`docs/agent-context.md`.

### GitHub

User OAuth device flow on a GitHub App with expiring user-to-server tokens, so PRs and comments are
authored as the user. Tokens last about eight hours; GitHub rotates the refresh token on every use,
so the same fenced CAS and loss window apply.

- The App is only the OAuth client registration. Refresh requires its client secret, a second
  control-plane-only secret (`pi-orb-github-client-secret`). Config: `PI_ORB_GITHUB_CLIENT_ID`,
  `PI_ORB_GITHUB_CLIENT_SECRET`; unset means `tokens/github` answers `auth_required` and no gate
  is wired.
- `GithubUpstreamRefresher` maps `bad_refresh_token` to `invalid_grant`. GitHub reports OAuth
  errors as HTTP 200 with an `error` field; adapters inspect the body.
- `GithubAuthGate` advances each ceremony at most one poll per `ensureAuth`, honoring interval and
  `slow_down`. `/user` fills `accountId` (fallback `"unknown"`).
- Tokens are the intersection of the user's access and the App installation. The App is
  installable on the owning account only; that covers the account's repositories for every
  authorized coworker. Visibility must change only to cover other accounts' repositories.
- An installation is required for writes (`403 Resource not accessible by integration` otherwise;
  `docs/postmortems/2026-08-05-github-app-installation.md`). `repository_selection=all` means the
  installation account's repositories only, so token issuance is not an access preflight
  (`docs/postmortems/2026-08-09-private-repo-clone-outside-github-app-installation.md`).

Rejected: installation tokens (bot authorship); a broker-vended fine-grained PAT (the token itself
is durable); any static env-var credential (baked into metadata, rotation bounces the fleet).

In the orb, `gh` comes from GitHub's apt repository. `/usr/local/bin/gh` is a shim that fetches a
token from `tokens/github` (one-shot CLI `apps/orb-runtime/src/gh/cli.ts`, ~10 s retry window) and
execs `/usr/bin/gh` with `GH_TOKEN`; a caller-supplied `GH_TOKEN` wins, and fetch failure runs gh
unauthenticated with the reason on stderr. A system-gitconfig credential helper serves
`https://github.com` only (`username=x-access-token`); process hosts get it via `GIT_CONFIG_*`
(`docs/host-provider.md`). It also serves the initial private clone. No `gh auth login` and no
`hosts.yml`: `$HOME` is the persistent orb home, and a stored token would outlive its short
lifetime. Repository-free projects keep the same shim, helper and auth requirements.

### Claude subscription

Not a renewable credential. One owner-level connection runs native `claude setup-token` in a
trusted auth-only control-plane helper; the browser's consent and completion code stay
owner-scoped and the one-year, model-only token goes straight into secret storage. No per-orb
login, credential scraping or API-billing fallback. Browser routes: `/api/v1/claude/auth` and
`/connect|code|cancel|disconnect` (user principal, exact Origin, JSON). Connect admits a ceremony
only on an explicit click, reuses an active one and never silently replaces a connected
credential. Sign-in UI: `docs/claude.md`.

The owner-bound `claude-subscription` pointer references an exact secret version with a static
shape (no fake refresh/expiry). `POST /runtime/v1/claude-subscription` uses the bearer fences,
requires the Claude harness, derives the owner and returns `{token, generation}` with `no-store`.
Only the SDK child gets `CLAUDE_CODE_OAUTH_TOKEN`; it never enters history, browser responses,
images or logs. Renewal repeats the ceremony. "Connected" means stored, not verified healthy. A Claude orb whose
owner has no connection waits in `creating`/`starting`; the owner sees `claude_subscription_login`
(no code; connect in Settings), others `owner_login_required` with provider `claude`.
Successful native verification persists sanitized metadata privately; failures stay visible and
admission fails closed.

Repository code can steal this bearer and use it until Anthropic revokes it or it expires;
clearing the pointer or revoking the orb's bearer does not revoke a copy.

Native helper drain: `cancel()` returns typed acceptance; `drain()` succeeds only after PTY exit,
process-group disappearance and scratch removal. Shutdown sends group SIGTERM, SIGKILL after five
seconds, and returns typed exit/cleanup uncertainty. Tokens emit only after cleanup; cancellation
or timeout never publishes. Uncertainty blocks replacement, keeps prior grants and shows failed
owner state. Edges: `claude-auth-*`, including `claude-auth-cancel-requested`,
`claude-auth-drained` (`drained`, `exitObserved`, `scratchRemoved`, `stage`),
`claude-auth-shutdown`, `claude-auth-shutdown-failed`. No tokens, codes, PTY output or private URLs.
The pinned terminal grammar is a fragile adapter, not a structured API. Harness use: `docs/claude.md`.

## Project secrets

Project-scoped environment secrets inherited by every current and future orb. Owner-level secrets
reuse the same design; precedence: `docs/agent-context.md`. MCP servers may reference them as
header values (`docs/mcp.md`). A secret protects its value in storage, APIs, UI, logs and metadata;
it cannot hide it from repository code once in the environment.

### Storage

The whole set is one immutable JSON bundle under one secret-store namespace:

```ts
interface StoredProjectSecretBundle {
  projectId: string;
  revision: number;
  values: Record<string, string>;
}

interface ProjectSecretPointer {
  projectId: string;
  revision: number;
  entries: Record<string, number>; // name -> last-updated ms; no values
  secretVersion: string;           // exact immutable version
  updatedAt: string;
}
```

Each update reads the bundle, changes one name, writes a new version and CAS-moves the pointer. A
failed CAS destroys the new version best-effort and retries; a successful move destroys the
superseded one best-effort. Reads fail closed if payload `projectId`/`revision` differ from the
pointer. No pointer means an empty snapshot; deleting the last name publishes an empty revision.

Crash residue: death after a version write but before it is recorded leaves an unreferenced
version. Project deletion therefore, after its fence and the 65-second deletion quarantine
(longer than the 30-second secret-write deadline), enumerates bundle headers and destroys every
version naming the project. A fleet sweeper, intent table and lease were rejected as too much
machinery for bounded residue.

Limits: names `[A-Za-z_][A-Za-z0-9_]*`; reserved `__proto__`, `PI_ORB_*`, `HOME`, `PATH` and broker
names; at most 100 names; the UTF-8 `JSON.stringify` of the whole bundle ≤ 64 KiB (Secret
Manager's payload limit), checked before any write with typed 400. NUL values are rejected at
publication and snapshot boundaries; existing ones stay listable and replaceable. Rejected:
chunking or per-backend limits.

### Browser API

`GET /api/v1/projects/:projectId/secrets` returns `{revision, items: [{name, updatedAt}]}` only,
never a value or fingerprint. `PUT .../secrets/:name {value}` and `DELETE .../secrets/:name` return
the same snapshot. Deleting an absent name is a no-op. Mutations conflict once project deletion
starts. Coworkers may change secrets.

A name referenced by the saved MCP catalog cannot be deleted: 409 naming the servers. Replacement
stays allowed. Catalog publication and pointer CAS share the project-row lock, so neither order of
a save/delete race slips through; a declined delete destroys its unpublished bundle. Publishing MCP
references to missing secrets is rejected the same way.

### Secrets tab

The Project Config Secrets tab is write-only: it lists names and update ages, never values, and
adds, replaces or removes one secret at a time; replacement means entering a new value. Rejected:
batch paste, where one malformed or repeated name could rotate several credentials. A referenced
name shows `used by <MCP names>` instead of its age and cannot be removed; removal is also disabled,
with the failure inline, when usage cannot be loaded. Returning to the tab or focusing the window
refreshes usage. The UI is never the enforcement boundary; the frontend fixture mirrors both server
checks. Writes wait for the initial metadata read so a late snapshot cannot overwrite a save. Name
inputs opt out of 1Password identity detection; values are password fields.

### Runtime snapshot

```text
GET /runtime/v1/project-secrets
Authorization: Bearer <runtime bearer>
200 { "revision": number, "values": { "NAME": "value" } }   Cache-Control: no-store
```

The route derives the project from the orb. Resolution reads pointer → exact version → validates →
rereads pointer; a changed pointer retries, an unchanged pointer with a bad payload fails closed.
A fetch racing replacement returns one complete revision.

The runtime fetches once per process boot, after identity-free `.agents/setup` and before
`.agents/resume`, merges into `process.env`, then starts services or the Claude session. It retries
401/5xx for up to three minutes (bearer hash may not be committed yet); a malformed success is
terminal. Resume, tools and terminals inherit it; setup does not. Platform environment wins, and
secret names join the `$HOME/.pi-orb/env` deny-list for that boot. Values never reach the
persistent home, provider metadata, history or logs.

An update reaches stopped orbs on next start and running orbs on next process boot; it does not
change the host-spec fingerprint. No applied-revision tracking or hot update.

Failure blocks readiness with typed `project_secrets_unavailable`; starting with a partial or empty
environment is forbidden. Lifecycle failure detail shows it; no names or values are logged. Healthy
fetches log nothing.

### Verification

DST targets only the domain service: concurrent writers (same/different names and projects),
snapshot during rotation, update versus delete, crash windows, and a failpoint sweep over pointer
and secret operations. Invariants: every pointer names a matching readable bundle; revisions are
monotonic; per-name mutations are linearizable; a snapshot is one revision; deletion admits no
later publication and removes every version; no output contains a value.
