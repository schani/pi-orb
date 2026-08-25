# Orb workload identity requirements

> **Status:** Requirements accepted 2026-08-21; implementation plan added 2026-08-21 (see
> "Implementation plan" below). **Implemented through stage 4 locally as of 2026-08-21**: the
> domain core, the crypto adapter and key management, the mint route, the `issuer` role's
> discovery/JWKS endpoints, the boot key hook, the per-orb identity status in the product, the
> in-orb `pi-orb id-token` CLI with its image shim and end-to-end coverage, and the cloud tier —
> the public `pi-orb-issuer` Cloud Run service, `PI_ORB_OIDC_ISSUER_URL` on both roles that need
> it, the signing-key parent secret, the separately invoked federation bootstrap
> (`infra/bootstrap-pi-orb-oidc.sh`), the release smoke (`infra/smoke-workload-identity.sh`), and
> the integration recipes (`docs/workload-identity-recipes.md`). **Hardened 2026-08-22** after a
> review of all four stages: see "Issuer hardening (2026-08-22)" below for the JWKS first-deploy
> window, the signing-material revocation window, the staged operator rotation, the fenced
> retirement, and the boot hook that no longer gates `listen`.
>
> **Remaining release gate:** the live GCP federation validation. Nothing in stage 4 has been
> applied to a real project or exchanged through a real STS; the deterministic-URL assumption, the
> deployed issuer's public reachability, the pool/provider bootstrap, and the smoke's ssh and STS
> legs are all unverified until that runs. Tracked in `TODO.md`.
>
> This document defines a provider-neutral OIDC identity that code running inside a pi-orb can
> exchange for short-lived credentials from cloud providers and private services. It does not grant
> any permission by itself: each relying party owns its trust policy and authorization. The
> relying-party side — how to configure GCP, AWS, and generic OIDC services to accept it — is
> `docs/workload-identity-recipes.md`.

## Purpose

Repository code and agents running in an orb eventually need to inspect logs, publish artifacts,
call private services, or operate cloud infrastructure. Long-lived API keys and service-account
keys in project environment variables are the wrong primitive: every process in the orb can read
them, they survive longer than the compute that needed them, and rotation becomes a fleet-wide
secret-distribution problem.

pi-orb must instead let an orb prove **which pi-orb deployment, project, orb, and compute
incarnation it is** with a signed, short-lived OpenID Connect token. A relying service verifies
that token and decides what the identity may do. Cloud-native federation can then exchange it for
provider credentials without storing a renewable cloud credential in pi-orb.

This is workload identity, not end-user login. It authenticates code executing in the orb. Since
the current product has no authenticated user or project-owner model, the initial token must not
claim a user identity. Adding one later requires a real authenticated principal in the control
plane, not an email, repository author, browser input, or caller-supplied string.

## Reference: how Amp OIDC works

Amp's mechanism is the reference behavior, not an implementation dependency. In an Amp-managed
orb, a workload runs:

```sh
amp orb id-token --audience urn:example:service
```

Amp returns an RS256-signed JWT, normally valid for ten minutes. Its public OIDC issuer exposes a
discovery document and JSON Web Key Set (JWKS), so a relying party can verify the signature,
issuer, audience, and expiration without calling back to the orb. Alongside standard claims,
Amp identifies the workspace (when present), Amp project, user, thread/orb, and token use. The
thread ID is suitable as a compact provider subject; authorization policies use immutable custom
claims rather than mutable names or email addresses.

For Google Cloud, the flow used by this repository is:

```diagram
┌──────────────┐   Amp-signed OIDC JWT   ┌─────────┐
│ Amp project  │────────────────────────▶│ GCP STS │
│ orb          │                         └────┬────┘
└──────────────┘                              │ validates issuer, audience,
                                              │ project ID and user ID
                                              ▼
                                   ┌─────────────────────┐
                                   │ Workload Identity   │
                                   │ Pool provider       │
                                   └──────────┬──────────┘
                                              │ may impersonate
                                              ▼
                                   ┌─────────────────────┐
                                   │ GCP service account │
                                   └──────────┬──────────┘
                                              │ short-lived Google token
                                              ▼
                                   ┌─────────────────────┐
                                   │ Google Cloud APIs   │
                                   └─────────────────────┘
```

The committed executable credential source mints a fresh Amp token on demand. Google's external
account credential configuration executes that source, exchanges the JWT through Security Token
Service, and impersonates a narrowly authorized service account. The configuration contains no
secret. The audience is not a password—another Amp orb can request the same audience—so GCP must
also constrain Amp's immutable identity claims. The resulting Google access token is temporary,
and Google audit records retain the service account and delegation context.

The important properties to reproduce are:

- the orb mints identity on demand instead of receiving a durable cloud secret;
- one public issuer supports many independently configured relying parties;
- the caller chooses the intended audience and the relying party checks it exactly;
- authorization uses immutable pi-orb identity claims;
- the signing key never enters the orb;
- standard SDK credential chains can refresh automatically through a reviewed executable helper;
- stopping an orb prevents new tokens, while short expiry bounds already-issued tokens.

Primary references: [Amp OIDC from Orbs](https://ampcode.com/manual/orbs/oidc) and
[Secrets of the Orb](https://ampcode.com/news/secrets-of-the-orb).

## Identity and trust model

### Principals

The initial workload principal is an orb, with every token also bound to its current live compute
incarnation. Its authoritative identity comes only from control-plane state:

- **deployment/issuer:** the pi-orb installation identified by the configured issuer URL;
- **project:** the immutable control-plane project ID;
- **orb:** the immutable control-plane orb ID;
- **compute incarnation:** the monotonic `host_incarnation` currently authorized for that orb.

Repository URL, project name, orb name, Git author, email, host reference, and cloud VM identity are
not authorization identities. They are mutable, user-controlled, provider-specific, or all four.

The existing 256-bit runtime bearer remains the bootstrap proof. It is minted per compute
incarnation, injected through the provider's existing runtime environment contract, persisted in
the control plane only as a SHA-256 hash, compared in constant time, and accepted only for live
lifecycle states. Possession means “code in this incarnation”; it does not mean “the human who
created this orb.”

### Token claims

An initial token must contain:

| Claim | Requirement |
| --- | --- |
| `iss` | Exact public HTTPS issuer configured for this pi-orb deployment. |
| `aud` | Exact non-empty audience requested by the workload. |
| `sub` | Compact, stable orb identity, no more than 127 bytes. The initial form is the orb ID; relying policies that distinguish replacement compute must also check `host_incarnation`. |
| `iat`, `exp` | Issued-at and expiration from the control plane's injected clock. Default lifetime ten minutes; accepted range one to sixty minutes. |
| `jti` | Unique, unpredictable token identifier. |
| `project_id` | Immutable pi-orb project ID. |
| `orb_id` | Immutable pi-orb orb ID. |
| `host_incarnation` | Current monotonic compute incarnation. |
| `token_use` | Literal `exchanged`, distinguishing workload exchange tokens from future token classes. |

The token must not initially contain `user_id`, `email`, `workspace_id`, cloud account IDs, access
roles, or permissions. If pi-orb later gains authenticated users and durable ownership, a
server-derived immutable `user_id` may be added as a new claim; existing relying policies must
continue to fail closed unless deliberately updated.

### Authorization responsibility

Minting a token confers no resource access. A relying party must verify at least:

1. signature against the issuer's current JWKS;
2. exact issuer;
3. exact audience;
4. current time within `iat`/`exp` under bounded clock skew;
5. `token_use == "exchanged"`;
6. the immutable project and/or orb claims appropriate to the grant.

A project-wide grant matches `project_id`. A one-orb grant matches both `project_id` and `orb_id`.
An incarnation-sensitive service additionally matches `host_incarnation`. Trusting only the
issuer or audience is insecure because any authorized orb may request any audience.

## Required product interface

The prescribed orb image must provide:

```text
pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]
```

Requirements:

- print only the JWT and a trailing newline to standard output on success;
- never print the runtime bearer, signing material, or token to standard error or logs;
- reject an absent/empty audience and out-of-range lifetime before making a request;
- return nonzero with a concise typed failure for an unreachable control plane, unauthorized/stale
  incarnation, invalid request, rate limit, or issuer failure;
- support command substitution and executable credential-source protocols;
- never cache the JWT on disk;
- not require interactive login, a browser, or a project secret;
- document that shell tracing around the command exposes the returned token.

The CLI name describes the product interface. It may be implemented as a small executable in the
runtime image or as an orb-runtime subcommand, but repository setup must not download an
unreviewed credential helper.

Implemented 2026-08-21 as `apps/orb-runtime/src/id-token/` behind the POSIX-`sh` shim
`apps/orb-runtime/docker/pi-orb` at `/usr/local/bin/pi-orb`, beside the existing `gh` and
git-credential helpers (`docs/host-provider.md`). Both `--flag value` and `--flag=value` forms are
accepted, and the entry point also accepts the leading `id-token` word the shim consumes, so the
process host provider — which has no image and therefore no shim — invokes the same CLI as
`node apps/orb-runtime/src/id-token/cli.ts id-token …`. The exit codes are part of the interface,
because an executable credential source has only the code to decide with:

| Code | Class |
| --- | --- |
| 0 | a token was printed |
| 2 | usage: bad arguments, or no orb runtime environment |
| 3 | unauthorized: this incarnation's bearer was refused |
| 4 | not mintable: the orb's lifecycle state forbids identity |
| 5 | rate limited: the per-orb mint floor is still in force |
| 6 | unavailable: control plane unreachable or transiently failing |
| 7 | internal: a control-plane bug, which retrying cannot fix |

The in-orb Pi agent learns the feature exists through the `cloud-identity` skill baked into the
runtime image at `apps/orb-runtime/skills/cloud-identity/SKILL.md` (mechanism and rejected
alternatives in `docs/pi-adapter.md`, added 2026-08-22): nothing in a user's checkout mentions
`pi-orb id-token`, so without it an agent asked to reach a cloud API looks for a stored key instead.
The skill also carries the relying-party side (rewritten 2026-08-25): given one GCP project ID it
chooses the pool, provider, service account, and audience itself and prints a pre-filled idempotent
`gcloud` block for a human to run with an admin identity outside the orb, rather than sending them
to `docs/workload-identity-recipes.md`. An admin credential never enters an orb.

The CLI retries only outcomes a later attempt can change — the first-boot 401 before the bearer
hash commits, the per-orb floor, and transient issuer/network failures — inside one 10-second
budget with the `gh` helper's 250 ms/2 s backoff, honoring `Retry-After` but never sleeping past
that budget: a `Retry-After` longer than the whole budget is an answer, not an instruction to
hang. `not_mintable`, `invalid_request`, and `internal` are returned on the first response.

Hardened 2026-08-22: `HttpIdTokenEndpoint` bounds each mint request with
`AbortSignal.timeout(MINT_REQUEST_TIMEOUT_MS)` — 3 s, comfortably under the CLI's 10-second budget,
so one silent attempt still leaves room for the retry a restarting control plane deserves. Without
it a control plane that accepts the connection and never answers hangs the CLI past its own budget,
and an executable credential source that hangs is worse than one that fails: the SDK invoking
`pi-orb id-token` inherits the hang. The abort surfaces as the ordinary typed `retryable` result,
never a rejected promise, on both the request leg and a stall mid-body — and only when the body read
actually failed, so a response that arrived complete is never discarded by a deadline firing during
parsing.

## Orb integration

### Request path

The runtime bearer must not be sent to an external relying party. Token minting follows the
existing internal runtime-authentication boundary:

```diagram
┌────────────────┐    local command     ┌──────────────────┐
│ Agent/project  │─────────────────────▶│ pi-orb id-token  │
│ process        │                      │ CLI (in orb)     │
└────────────────┘                      └────────┬─────────┘
                                                 │ authenticated request
                                                 │ with incarnation bearer
                                                 ▼
                                      ┌─────────────────────┐
                                      │ Control plane OIDC  │
                                      │ issuer              │
                                      └──────────┬──────────┘
                                                 │ signed short-lived JWT
                                                 ▼
                                      ┌─────────────────────┐
                                      │ Relying party / STS │
                                      └─────────────────────┘
```

1. The workload invokes `pi-orb id-token` with an audience and optional lifetime.
2. The CLI reads the injected runtime environment (control-plane runtime URL and per-incarnation
   bearer) and calls a versioned control-plane runtime endpoint directly, exactly like the
   existing in-orb `gh` and git-credential helpers. The request includes only audience and
   requested lifetime; identity is never supplied by the caller.
3. The control plane hashes and constant-time verifies the bearer, loads the orb, and derives all
   identity claims from that row.
4. The authorization decision is one consistent snapshot read of that orb row: the bearer hash
   matches, no discard fence covers the incarnation, and the orb is in a lifecycle state
   authorized to mint. That read is the mint's linearization point relative to stop, replacement,
   archive, and delete: a lifecycle change committed before the read denies the mint, while a mint
   whose read linearized first remains valid even if its response arrives after the change
   commits.
5. The per-orb rate-limit floor is then *claimed* by a separate atomic conditional write, after
   the snapshot read and before signing: `last_mint_at` moves to now only if the previous mint is
   at least the minimum interval old. The floor cannot be part of the snapshot read (decided
   2026-08-21): reading it and then advancing it lets N concurrent requests all pass the same
   stale check and all mint, so the claim has to be the check, and of any number of racing callers
   exactly one wins. Like the failure status the claim bumps no lifecycle state version, so it
   never conflicts with lifecycle CAS. A claim consumed by a mint that then fails at the signer is
   deliberately not refunded: a signer outage under load must not become an unthrottled retry
   loop, and the cost of a lost slot is one delayed token.
6. It signs and returns a token with `Cache-Control: no-store`.
7. The CLI prints the token to its one caller. Neither the CLI nor the control plane persists it.

Decided 2026-08-21: the CLI calls the control plane directly with the injected bearer, matching
the existing in-orb credential helpers. Rejected: a loopback-only orb-runtime hop (CLI → orb
runtime → control plane). The runtime's HTTP server has no loopback-only listener, and the hop
would add no security boundary: every process in the orb already inherits the bearer through the
runtime environment, an exposure accepted in `docs/credentials.md`. The invariant that matters is
unchanged — the bearer travels only to the control plane, never to an external relying party.

The runtime endpoint belongs beside the existing `/runtime/v1/tokens/{name}` broker boundary, but
OIDC identity is not another brokered upstream credential: the control plane is the issuer and no
refresh token exists. It therefore needs a distinct request/response schema and route.

### Lifecycle behavior

- `creating`, `starting`, and `running` may mint once the incarnation bearer hash is durably
  committed. The existing pre-commit boot race may be retried for a bounded period, exactly as the
  credential broker retries an initial 401.
- `stopping`, `stopped`, `failed`, `archiving`, `archived`, `deleting`, and missing orbs must not
  mint. A stop request therefore closes minting before host shutdown completes.
- Replacing compute rotates the runtime bearer and advances `host_incarnation`; the old
  incarnation can never mint for the new one.
- Stop/start of the same retained host incarnation keeps the same bearer but cannot mint while
  stopped.
- Archive and deletion revoke minting before destructive cleanup and never resurrect it during
  retries.
- An already-issued JWT cannot be revoked from an offline verifier. Its own expiration bounds that
  residual access. A downstream STS may issue credentials with a longer lifetime; integrations
  must request the shortest supported session and document that effective revocation window.

### Host-provider boundary

Docker, process, GCE, and future providers must not implement OIDC or hold signing keys. They keep
their existing responsibility: place the control-plane runtime URL, orb ID, host incarnation, and
per-incarnation bearer into the runtime's private launch channel. The in-orb CLI and the control
plane compose the provider-neutral identity flow above.

Repository code is considered able to read the current runtime environment and invoke the local
CLI. Preventing code in an orb from minting that orb's identity is not a goal; limiting what that
identity can do belongs in relying-party policy. One orb must never mint another orb's identity.

## Issuer and signing requirements

- Expose an HTTPS OIDC discovery document at
  `/.well-known/openid-configuration` beneath a stable issuer URL and a public JWKS endpoint.
- Initially sign with RS256 for broad federation compatibility. Every JWT carries a `kid`.
- Signing, JWK export, and `kid` derivation are first-party code over `node:crypto` behind a
  simulation-friendly signer port (decided 2026-08-21; the dependency decision and the rejected
  `jose` alternative are recorded in `docs/stack.md`).
- Keep private signing keys outside orb hosts, container images, PostgreSQL state, logs, and source
  control. In cloud deployment they live in a dedicated secret/KMS boundary readable only by the
  issuer service identity.
- Support overlapping key rotation: publish the new public key before signing with it, retain old
  public keys for at least the maximum JWT lifetime plus verifier cache/clock-skew allowance, then
  remove them. Rotation must not require restarting orbs.
- Discovery is public and cacheable. JWKS is cacheable only when it has something to say: a key set
  that is empty or unreadable is answered uncached, never cached as an authoritative "no keys"
  (2026-08-22, below). Neither document contains a secret. Token-mint responses are `no-store`.
- If signing material is unavailable, fail closed with a typed retryable error. Never fall back to
  an unsigned token, another deployment's key, or a long-lived static token. "Available" means
  *readable*, not merely referenced by a row: a boot that establishes a key reads its material once
  before reporting success, and a signer reusing material it read earlier revalidates it on a
  bounded interval, so destroying a secret version stops signing within a known window rather than
  whenever the process happens to restart (2026-08-22, below).
- The issuer URL is part of the security identity. Changing it is a breaking trust migration and
  must not occur implicitly from request host headers.

## Federation integrations

The implementation must ship reviewed recipes and helpers for at least:

### Google Cloud

- Workload Identity Pool OIDC provider with exact issuer and allowed audience;
- attribute mappings for `project_id`, `orb_id`, and `host_incarnation`;
- an attribute condition requiring `token_use=exchanged` and the intended project/orb;
- direct federated access where supported, otherwise narrowly scoped service-account
  impersonation through `roles/iam.workloadIdentityUser`;
- a generated external-account configuration whose executable source calls
  `pi-orb id-token`; the configuration and helper contain no secret;
- explicit `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` only around the reviewed helper.

### AWS

- IAM OIDC provider and role trust policy matching exact issuer/audience;
- a subject-scoped policy for one-orb grants. Amended 2026-08-22: the original requirement of a
  "subject/custom-claim policy scoped to the intended project/orb" is not expressible on AWS —
  role trust policies for a self-registered OIDC issuer can condition only on a fixed key
  allowlist (`aud`, `sub`, and a few others), never on custom claims like `project_id` or
  `token_use`, so a one-orb grant conditions on `sub` (the orb ID) plus `aud`, and a project-wide
  grant needs an explicit workaround (`docs/workload-identity-recipes.md` documents the options
  and their caveats);
- a mode-0600 temporary web-identity token file and short role session;
- cleanup and refresh instructions that do not put the JWT in shell history.

### Generic OIDC relying services

- discovery/JWKS verification guidance;
- exact claim-validation rules and clock-skew limits;
- examples for project-wide and one-orb authorization;
- an explicit warning that audience alone is not authorization.

The existing Tailscale control-plane OAuth-key flow in `docs/ports.md` does not change merely
because OIDC exists. Migrating it to Tailscale trust credentials is separate product work and must
preserve exact-orb tags, ephemeral nodes, lifecycle cleanup, and current user-visible diagnostics.

## Policy, abuse bounds, and failures

- Minting is allowed for arbitrary syntactically valid audiences, matching standard OIDC and Amp's
  model. Audience values have a bounded UTF-8 length and must not enter structured logs without
  safe encoding.
- Apply a per-orb mint rate limit: a durable minimum interval between successful mints, following
  the credential broker's persisted refresh floor. Return a typed retryable result and
  `Retry-After`; do not use exceptions for expected throttling. Rejected for the POC (2026-08-21):
  a deployment-wide limit — per-orb throttling bounds the abuse that matters, and a correct
  cross-instance global counter is machinery the POC does not need.
- Bound request body size, audience length, token lifetime, signing concurrency, and response size.
- Every first-party fallible boundary returns `neverthrow` `Result`/`ResultAsync` with a
  discriminated error. Crypto, KMS, HTTP, and platform exceptions are caught at their immediate
  adapters.
- Never accept identity claims from the request, repository files, host metadata not corroborated
  by durable state, or environment variables.
- Never place a JWT in a URL, process argument beyond the explicit CLI output contract, lifecycle
  event detail, exception, metric label, tracing attribute, or test failure snapshot.
- A malformed request, stale bearer, stopped orb, signing outage, and rate limit must remain
  distinguishable to the local caller without revealing whether another orb exists.

## Observability and failure visibility

Workload identity is security-sensitive, and its failures must be visible to the orb user without
recording tokens.

- Persist the latest mint failure per orb as durable columns: a typed denial/error code and a
  timestamp, nothing else. The write must not bump the lifecycle state version, so failure status
  never conflicts with lifecycle CAS. Raw audience values do not enter this status.

  The columns are never cleared, and the only thing that retires a failure is a *later successful
  mint*, decided on read (`mintFailureAt >= lastMintAt`). **Decided 2026-08-22: the status is
  therefore a historical report, not a statement about the orb's present ability to mint, and every
  consumer must present it in the past tense.** Most orbs never call `pi-orb id-token` at all, so a
  `not_mintable` denial recorded during an ordinary stop window is never superseded: the orb
  restarts healthy and the denial is still the latest recorded outcome. A present-tense banner
  ("Workload identity unavailable") would then be a standing lie on a perfectly good orb. Rejected:
  clearing the columns on start or on a lifecycle transition — that puts identity status back on the
  lifecycle CAS path, which is exactly what the no-clearing-write design buys. The product renders
  it as "Last workload-identity mint failed: `<code>` (at `<time>`)"; the code and the timestamp are
  what make it actionable, since they let the user judge whether the attempt predates whatever they
  last changed.

  **Denial status writes are deduplicated against the code already on the orb row (decided
  2026-08-22).** `not_mintable` and `invalid_request` are decided *before* the rate-limit slot is
  claimed, so without dedup a caller holding a stopped orb's bearer drove one `UPDATE` per request
  against no floor at all. The consequence is a deliberately stale `mintFailureAt`: through a run of
  identical denials it stamps the first request, not the latest, which is why the product surfaces
  this as a *last failure* rather than a *latest timestamp*. The dedup is conditioned on the
  existing status still being *visible*: `http/views.ts` hides a failure older than `lastMintAt`, so
  a repeat denial after a healthy stretch writes again rather than deduplicating against a status
  the user can no longer see. Without that condition an orb that starts failing again after a
  successful mint would go silent permanently.
- Never persist the JWT, runtime bearer, private key, or downstream cloud credential.
- The CLI reports actionable failures to the orb user. A dashboard/API identity status must expose
  issuer readiness and the latest non-secret mint failure for that orb; a silent refusal is not
  acceptable.
- Healthy minting is silent: successful mints produce no lifecycle events and no durable pi-orb
  record beyond the rate-limit timestamp. Denials caused by expected stale/stopped callers are
  edge-deduplicated in operational logs.
- Key activation/retirement, signer unavailability edges, sustained throttling, and policy/config
  changes produce durable operator-visible security events.
- Downstream provider audit logs are the forensic trail for issued tokens: federation recipes must
  map the delegated principal/session back to pi-orb's immutable `project_id`, `orb_id`, and
  `host_incarnation` claims, so a misused token identifies its orb from the provider's side.
- Rejected for the POC (2026-08-21): a durable per-mint audit table (timestamp, identity claims,
  `jti` hash, audience, key ID, outcome per decision) with fail-closed commit-before-return
  semantics. It was the largest piece of new machinery in the feature, and its forensic value is
  mostly recoverable from provider-side audit logs; the accepted cost is that pi-orb cannot
  enumerate what it minted or for which audiences. If that trade stops being acceptable, adding
  the table later is an ordinary schema migration.

## Deterministic verification requirements

Concurrency-critical issuance and revocation must sit behind simulation-friendly clock, random,
signer, and orb-store ports. Deterministic scheduling tests must cover at least:

- valid mint from each allowed lifecycle state;
- denial in every disallowed state;
- stop racing mint, proving no mint decision linearizes after the stop's state transition commits
  (a mint that linearized first remains valid even if its HTTP response arrives after the stop);
- compute replacement racing mint, proving the old bearer cannot mint the new incarnation;
- archive/delete and discard-fence races;
- first-boot request before bearer-hash commit followed by bounded successful retry;
- signer failure and recovery, never returning an unsigned token;
- failure-status and rate-limit-timestamp writes racing lifecycle CAS without state-version
  conflicts;
- per-orb rate-limit enforcement under concurrent requests across control-plane instances;
- key rotation with old/new verifier caches and retirement after the overlap window;
- clock boundaries, skew, minimum/maximum lifetime, malformed audiences, and unique `jti` values;
- two orbs attempting cross-orb token use;
- reproducible failure traces for every discovered schedule-sensitive defect.

Non-simulation coverage must include:

- cryptographic signature verification against the served JWKS;
- discovery-document conformance;
- protocol schema and `Cache-Control: no-store` tests;
- Docker, process, and GCE composition tests proving the same provider-neutral flow;
- an E2E fake relying party that rejects wrong issuer, audience, project, orb, incarnation,
  expiration, and signature;
- a live GCP federation smoke in deployment validation, using a read-only test grant before any
  deployment-capable role is admitted.

## Acceptance criteria

The feature is complete only when:

1. A fresh orb with no injected cloud credential can run `pi-orb id-token --audience ...` and
   obtain a verifiable, short-lived JWT.
2. A documented GCP external-account configuration automatically exchanges fresh pi-orb tokens
   and successfully calls an authorized read-only API.
3. The same token is rejected for a different audience, project, orb, expired lifetime, stopped
   orb mint attempt, and replaced incarnation.
4. No private signing key, runtime bearer, JWT, or downstream access token is present in the
   repository, image, PostgreSQL rows other than permitted one-way hashes, normal logs, or orb
   persistent filesystem.
5. User-visible failures explain why identity is unavailable: the latest typed non-secret mint
   failure for an orb is durably persisted and exposed in the product.
6. Provider implementations remain unaware of OIDC and all supported host providers pass the same
   contract tests.
7. The deterministic race suite and full runtime E2E pass, including stop/replacement revocation
   boundaries.

Reconciled 2026-08-21 against what stage 4 leaves true:

| # | Status |
| --- | --- |
| 1 | **Met in the E2E slice, unverified live.** `e2e/full-slice.e2e.test.ts` mints through the shim in a Docker orb and verifies against the served JWKS. `infra/smoke-workload-identity.sh` is the same proof against real GCE and the deployed issuer, and has not been run. |
| 2 | **Written, not demonstrated.** The configuration generator, the reviewed helper `scripts/pi-orb-gcp-identity`, and the recipe are in `docs/workload-identity-recipes.md`; the smoke performs the equivalent exchange explicitly (STS → impersonation → a read-only API). No live STS has yet accepted a pi-orb token. This is the criterion the release gate exists for. |
| 3 | **Met except live.** Wrong audience, wrong issuer, tampered signature, stopped-orb `403 not_mintable`, discarded-incarnation `401`, and an out-of-range TTL are all covered in the E2E suite and the DST scenarios; the smoke re-proves wrong-audience (at STS), stopped-orb 403, and unknown-bearer 401 on real infrastructure. |
| 4 | **Met, and the deployment tier preserves it.** Private keys exist only as Secret Manager versions under `pi-orb-credential-oidc-signing-key`; the public issuer service runs as its own service account with no access to them. The smoke moves tokens through pipes and mode-0600 files in a mode-0700 directory removed on exit, and prints claims, never tokens. |
| 5 | **Met.** `OrbView.identity` plus the orb page banner (stage 2B). |
| 6 | **Met for provider unawareness, partial for test parity.** No provider knows about OIDC; the four launch inputs were already injected before stage 1. But the identity E2E legs go through `docker exec`, so they run only on the Docker backend — the process backend has no exec seam (its CLI path is covered by unit tests only), and the GCE composition is exercised solely by the unrun live smoke. "All supported host providers pass the same contract tests" is not yet demonstrated for the identity path (noted 2026-08-22). |
| 7 | **Met at the last full run.** Re-run both before the live gate. |

## Implementation plan

Four stages, each independently mergeable and leaving `main` deployable. Stages 1–2 are inert in
the product until the CLI ships in stage 3; that is deliberate, so the security-critical core is
reviewed and DST-hardened before anything can call it. Host providers are untouched in every
stage: all four identity inputs (control-plane runtime URL, orb ID, host incarnation, bearer)
are already injected by Docker, process, and GCE, and adding no launch input also avoids
perturbing the immutable host-spec fingerprint (`docs/compute-replacement.md`).

### Stage 1 — protocol, store, domain core, deterministic tests

- `packages/protocol/src/workload-identity.ts`: an `ID_TOKEN_PATH` constant beside
  `RUNTIME_TOKENS_PREFIX`, plus closed TypeBox schemas — request `{audience, ttlSeconds?}` with
  the audience byte bound, success `{token}`, and a runtime-style error envelope with codes
  `invalid_request | unauthorized | not_mintable | rate_limited | retryable` (optional
  `retryAfterMs`). `unauthorized` covers unknown, stale, and fenced bearers identically, so the
  response never reveals whether another orb exists. Discovery/JWKS document shapes stay inside
  the control plane: they have one producer and no first-party consumer.
- Migration `011_workload_identity.sql`: on `orbs`, the columns `mint_failure_code`,
  `mint_failure_at`, and `last_mint_at`; a new `oidc_signing_keys` table (`kid` primary key,
  secret-store version reference, public JWK JSON, state `pending | active | retired`,
  timestamps, row-version CAS). Public JWKs are not secrets and may live in PostgreSQL; private
  keys exist only in the secret store, addressed by exact version.
- Ports in `domain/ports.ts`: `TokenSigner` (claims in, `{jwt, kid}` out, typed retryable signer
  errors), `SigningKeyStore` (create/activate/retire/list, CAS-fenced), and a mint-ID entropy
  port for `jti`. New `ControlPlaneStore` methods: `recordMintFailure` (no state-version bump,
  following `recordHostDiscardStatus`/`touchLastBusy`), `claimMintSlot` (the atomic conditional
  floor write of request-path step 5), and the signing-key operations — each implemented in the
  PostgreSQL adapter, the in-memory store, and the shared store contract suite.
- `domain/workload-identity.ts`: `MINT_STATES = creating | starting | running` — deliberately
  narrower than the broker's `RUNTIME_TOKEN_STATES`, which admits `stopping` and `archiving` —
  and a `mintIdToken` function implementing the request-path steps above, with `IssuerConstants`
  (default lifetime 600 s, bounds 60–3600 s, audience byte cap, per-orb mint-interval floor) in
  `domain/constants.ts` and test overrides in the testkit fixtures.
- Testkit: a fake signer and key store; the `signer.sign` failpoint beside the signing-key table's
  `issuer.signing-key.read`/`.write`; a `workload-identity.dst.test.ts` covering the deterministic
  checklist above. Templates: the broker DST storm/rate-limit/failpoint scenarios and the
  lifecycle DST stop-race scenario with a live reconcile loop. The domain's constant-time hash
  comparison is a pure character-code loop rather than the routes' `timingSafeEqual`, because
  domain code may not import `node:crypto` (docs/testing.md).

### Stage 2 — HTTP route, issuer endpoints, real keys

- Factor the duplicated bearer-authentication logic in `http/runtime-routes.ts` into one shared
  helper, then add `POST` `ID_TOKEN_PATH` using it with `MINT_STATES`: `Cache-Control: no-store`
  on success, `Retry-After` on throttle, store `unavailable` as 503 retryable, store `invariant`
  as 500 (`docs/lifecycle.md`).
- `adapters/oidc/`: the `node:crypto` signer adapter (RS256, base64url, `kid` header), RSA key
  generation, JWK export, and RFC 7638 thumbprints, every platform throw caught at the adapter
  into typed results; private key bytes through the existing secret-store port (Google Secret
  Manager in cloud, file store locally), exact versions only.
- Boot: any role that mints calls `ensureActiveSigningKey` (`domain/signing-keys.ts`), which is
  idempotent and fails closed when the key store or the secret store is unavailable (the digest-pin
  boot-validation precedent). Implemented 2026-08-21: it prefers activating an already-published
  `pending` key over generating one — that is how an interrupted rotation is repaired — and only
  when nothing exists at all does it generate, write the PKCS#8 PEM through the existing
  secret-store port under provider `oidc-signing-key` (exact versions, never `latest`), and insert
  the row *directly* as `active`. Publishing a first key as `pending` first would buy nothing: no
  verifier can hold a cached key set that would have explained a key that never existed, and the
  alternative to signing with it is not signing at all. Two instances booting together therefore
  race on the unique-active index rather than on a read; the loser re-reads, destroys the secret
  version nobody references, and adopts the winner's key. It never destroys a version whose row it
  cannot prove absent, because an unreferenced version is inert while destroying a referenced one
  breaks the issuer permanently.
- Rotation is an ops action in three durable steps (decided and implemented 2026-08-21; split into
  two operator-invoked stages with an enforced soak window and fenced retirement on 2026-08-22, see
  "Issuer hardening" above). **Publish:** insert the new key as `pending`, so JWKS serves it beside the still-active
  old key and verifiers can refresh their cache before anything signs with it. **Retire:** CAS the
  old key `active` → `retired`; it stays published for the overlap window, so tokens it already
  signed keep verifying. **Activate:** CAS the new key `pending` → `active`. The last two cannot be
  one write, because the schema permits exactly one active key, so rotation has a short window in
  which none is active. A crash inside that window is not a lost issuer: minting fails closed with
  a retryable error until the next `ensureActiveSigningKey` — which every minting instance runs at
  boot — or a repeated rotation activates the published key. Re-running rotation adopts an existing
  `pending` key instead of stacking another one. Rejected: activating before retiring (the schema
  refuses it), and a combined transactional store operation that would close the window (new store
  machinery for an ops-only path whose failure mode is already recoverable). No orbs restart.
- JWKS is a view over the same rows: `pending` + `active` + `retired` within
  `IssuerConstants.jwksOverlapMs` — the maximum token lifetime plus five minutes for verifier cache
  staleness and clock skew — with the active key first. Retired rows and their secret versions are
  deliberately *not* deleted in this stage: leaving the served set is what the overlap window
  governs, while removing the row and destroying its material is later work under the same TODO
  item. A retired row carrying no `retiredAt` is kept rather than guessed about, since publishing a
  spare public key is harmless where dropping one too early breaks live tokens.
- A new `PI_ORB_ROLE=issuer` branch registering `GET /.well-known/openid-configuration` and the
  JWKS endpoint (active plus retiring keys) straight from `oidc_signing_keys` — public,
  cacheable, secret-free, so the issuer service needs no secret-store access. The issuer URL
  comes from a required `PI_ORB_OIDC_ISSUER_URL` validated at boot, never from request headers;
  `role=all` serves the same routes locally.
- The persisted mint failure surfaces through `http/views.ts` and the web UI as per-orb identity
  status alongside issuer readiness.
- Tests: route tests via injection, discovery-document conformance, and signature verification of
  minted JWTs against the served JWKS using `node:crypto` verify.

Stage 2 landed in two parts. **2A** (2026-08-21) is everything below the HTTP layer:
`adapters/oidc/jose.ts` (unpadded base64url, RS256 signing, 2048-bit RSA generation, JWK export,
and RFC 7638 thumbprints checked against the RFC's own published vector), `adapters/oidc/signer.ts`
(`OidcTokenSigner`, `NodeCryptoSigningKeyGenerator`, `CryptoMintIdSource`), `domain/signing-keys.ts`
(the key management above plus `assembleJwks` and the material cache), and
`domain/signing-keys.dst.test.ts`. The signer holds the private PEM in memory keyed by `kid` *and*
secret version, so the active row is still read per signature and a rotation is a cache miss by
construction. **2B** is the wiring: the shared bearer-authentication helper, the mint route, the
`issuer` role with discovery and JWKS, the boot hook, and the per-orb identity status in
`http/views.ts`.

Stage 2B landed 2026-08-21 (`http/runtime-routes.ts`, `http/issuer-routes.ts`, `main.ts`,
`http/views.ts`, `apps/web/src/pages/OrbPage.tsx`). Five decisions taken while implementing it:

- **The mint route does not pre-authenticate.** The two older runtime routes resolve the bearer at
  the HTTP boundary through the now-shared helper; the mint route hashes the bearer and hands the
  hash straight to `mintIdToken`, because the domain's snapshot read of the orb row *is* the mint's
  linearization point against stop, replacement, archive, and delete. A route-level check would be
  a second, earlier read whose verdict the domain would then have to ignore. The shared helper
  still distinguishes a store outage from a refusal, which is why the broker route can answer 503
  where a naive 401 would tell a live runtime its incarnation is dead. The orb-name trigger keeps
  folding a store outage into 401 exactly as before; the honest 503 is tracked in `TODO.md`.
- **`internal` is a wire error code** (deviation from stage 1's five-code envelope). `MintError`
  already carried `internal` for a `StoreError` of code `invariant`, and `IdTokenErrorSchema` had
  nowhere to put it. Rejected: reporting it as `retryable` with HTTP 500 — that is precisely the
  "client retries forever a deterministic bug" defect of
  `docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`. The full HTTP fold is
  `invalid_request` 400, `unauthorized` 401, `not_mintable` 403, `rate_limited` 429 with
  `Retry-After`, `retryable` 503, `internal` 500, success 200 with `Cache-Control: no-store`.
- **`PI_ORB_OIDC_ISSUER_URL` is canonicalized to a bare origin** — scheme, host, non-default port,
  no trailing slash, no path, query, fragment, or credentials — and validated before any boot side
  effect, beside the GCE digest-pin check. `https:` is required except for `127.0.0.1`,
  `localhost`, and `[::1]`, so local development needs no certificate. A path is refused rather
  than dropped: the well-known endpoints are served at the origin root, so a path-carrying issuer
  URL would advertise documents that are not there, and `https://x` versus `https://x/` must never
  become two trust identities. `role=all` defaults it to `http://127.0.0.1:<port>`; `issuer` and
  `runtime` must be told, and refuse to boot otherwise.
- **Discovery advertises only what exists**: `response_types_supported: ["id_token"]` (the field is
  REQUIRED by OpenID Discovery and this issuer mints ID tokens directly, with no authorization or
  token endpoint to advertise), `subject_types_supported: ["public"]`,
  `id_token_signing_alg_values_supported: ["RS256"]`, and the claim list above. Both documents are
  served `public, max-age=300`: five minutes is the same verifier-staleness allowance
  `jwksOverlapMs` already budgets for on the publishing side. Amended 2026-08-22: that holds for the
  discovery document and for a JWKS response that has keys in it; an empty or unreadable key set is
  answered uncached (see "Issuer hardening" above). The two document shapes stay in the
  control plane — one producer, and the consumers are external verifiers reading OIDC Discovery
  and RFC 7517.
- **The boot key hook never fails the boot.** `runtime`/`all` run `ensureActiveSigningKey` with a
  small bounded retry; on persistent failure they log one durable operator-visible edge and keep
  serving. The runtime role is also the credential broker every running orb depends on, so failing
  closed at boot would trade a feature outage for a fleet outage. Minting then fails closed per
  request with typed retryable errors, and the next boot or an operator rotation repairs it.
  Migrations remain the browser role's job alone.

The per-orb identity status is `OrbView.identity` (`{failureCode, failureAt}`, absent when there is
nothing to report). Currency is decided on read: the failure is exposed only while
`mintFailureAt >= lastMintAt`, so a later successful mint supersedes it with no clearing write and
the status stays off the lifecycle CAS path. The orb page renders it as a compact banner.

### Issuer hardening (2026-08-22)

A review of stages 1–4 found seven defects in the issuer's key handling and its public surface. The
decisions taken while fixing them, and the alternatives rejected:

- **JWKS answers 503, never 500, and never an empty key set.** An empty `oidc_signing_keys` table
  served `200 {"keys":[]}` with `public, max-age=300`, so any verifier or cloud STS that asked
  during the window before the boot hook established a key cached *emptiness* for five minutes and
  rejected the deployment's very first minted tokens. Zero keys now answer an uncached
  `503 {"error":"unavailable","message":"no signing keys published yet"}`. And a not-yet-migrated
  table surfaces as SQLSTATE 42P01 → `StoreError` code `invariant` → the 500 that
  `docs/lifecycle.md` prescribes — but `PI_ORB_ROLE=issuer` is the one role that never runs
  migrations, so this is a real race against the browser role's migration, and 500 tells the
  verifier not to come back. On this route only, every store failure — `invariant` included —
  answers the same uncached `503 unavailable`. The invariant→500 rule (from
  `docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`) exists so *internal* loops do
  not retry our own deterministic bugs; it stands everywhere the retrier is ours, and is
  deliberately not applied where the caller is an external verifier that cannot act on the
  distinction and where the misclassified case is genuinely retryable. Both refusals keep the
  fixed-string body: a raw store message on the deployment's one public unauthenticated route would
  hand SQL fragments to the internet. The discovery document is unchanged — static configuration,
  still `200` and `public, max-age=300` even before the first key exists, because a verifier may
  pin the issuer long before then.

- **Cached signing material expires.** `SigningKeyMaterialCache` keyed only on (`kid`,
  `secretVersion`), which makes a rotation a cache miss but makes *revocation* invisible:
  destroying the active key's secret version leaves the row untouched, so a warm signer kept
  signing with destroyed material for the life of the process. Since destroying the version is
  precisely how an operator kills a leaked key without waiting for a rotation to converge, that was
  a revocation with no window at all. Material is now revalidated after
  `IssuerConstants.signingKeyMaterialTtlMs` (60 s) on the injected monotonic clock, which is the
  revocation window for that case. Rejected: reading the secret per signature — the cache exists
  because the mint path is the hot path, and a bounded window is the trade the design already makes
  for the row read.

- **Rotation is staged, and is reachable.** `rotateSigningKey` activated microseconds after
  publishing, so the `pending` state existed but the verifier-cache overlap it exists for was never
  granted; and it had no production caller at all, so an operator could not rotate a leaked key.
  The operator flow is now two requests on the private browser/`ops` API:

  ```text
  POST /api/v1/issuer/signing-keys/publish     → the new key appears in JWKS, still not signing
  (wait at least the JWKS max-age — the activate stage enforces it)
  POST /api/v1/issuer/signing-keys/activate    → retire the old key, activate the new one
  ```

  `activate` refuses with a non-retryable `409 conflict` while the newest published key is younger
  than `IssuerConstants.rotationSoakMs` (10 minutes — twice the JWKS `max-age`, so even a verifier
  that fetched the key set one instant before publication has re-fetched). `{"force": true}`
  overrides it for the leaked-key emergency, where a few tokens rejected by a stale verifier cost
  less than one more minute of signing with a key someone else holds. The routes are registered
  only where key management is wired in: the public `issuer` role publishes JWKS and must not be
  able to change what it publishes, and the `runtime` role is the credential broker every orb
  depends on. `rotateSigningKey` survives as the unstaged form the recovery scenarios and the
  composition tests drive; it takes no soak because it publishes the key itself.

- **Rotation retires only the key it started from.** The convergence loop retired *whatever was
  active when the loop got around to it*, so two rotations converging at once let the slower one
  retire the key the faster one had just activated — opening a no-active-key window for nothing,
  and then escalating out of it by CASing a retired row back to `active`, which migration 011's
  `oidc_signing_keys_timestamps_complete` refuses outright. Retirement is now fenced to the exact
  (`kid`, `rowVersion`) that was active when the rotation started, pinned *before* the publish step
  rather than after it (publishing is the slow part and therefore the window a concurrent rotation
  finishes in). When the fence conflicts, the rotation re-reads and adopts the other rotation's
  outcome, leaving its own key published-but-unused — exactly what this document already promised
  the loser's key would be. A key that has left the signing set never re-enters it: the schema
  refuses the resurrection, and so does the design, because a resurrected key would start signing
  without the publish overlap that made it safe.

- **Establishing a key means proving it can sign.** `ensureActiveSigningKey` returned an active row
  without reading its material, so an issuer whose secret version had been destroyed booted
  "healthy" and the only symptom was a per-orb `signer_failure` on the first workload that asked
  for a token. It now reads the material once before declaring success and logs a durable
  `issuer-key-unusable` edge when it cannot. Separately, the no-key path generated a fresh key and
  wrote a fresh private-key secret version on *every* convergence attempt, so a store that kept
  refusing left up to attempts × boot-retries orphaned private keys behind; the generated key is
  now carried across attempts, and the loser's version is destroyed on every exit where its row is
  provably absent and another key holds the active slot — not only on the one branch that used to
  check.

- **The boot key hook never gates `listen`.** It ran awaited *before* `app.listen`, with raw
  `setTimeout`/`Date.now()` retries. A database that refuses answers fast, but one that hangs — a
  saturated pool, a partition that drops packets instead of resetting — answers never, and the
  runtime service is the credential broker every running orb depends on. The hook now runs after
  the socket is open, fire-and-forget, on the task's clock, and reports giving up as a durable
  `lifecycle:` `issuer-key-unavailable` event rather than free-text stderr, because "why could this
  instance not sign?" is asked long afterwards and has to be queryable beside the key events the
  ensure itself emits. Identity is one feature; listening is the whole service.

- **The in-memory signing-key store enforces the schema's timestamp check.** Migration 011 refuses
  `retired` → `active` while `retired_at` stands, activation without an `activated_at`, and
  retirement of a key that never activated; the fake accepted all three, which is why the rotation
  defect above could hide behind green tests. Both drivers now prove those three refusals in
  `signingKeyStoreContractTests`.

### Stage 3 — CLI, image, end-to-end

- `apps/orb-runtime/src/id-token/`: the request/validation logic (reusing the broker env reader;
  argument and bounds validation before any request; the bounded first-boot 401 retry with the
  tighter CLI-scale constants used by the `gh` helper) plus a thin argv entry point, and a
  `docker/pi-orb` shim installed as `/usr/local/bin/pi-orb` following the `gh`/git-credential
  discipline: JWT and trailing newline on stdout only, typed failures on stderr, nonzero exit
  codes, nothing cached. Assert the shim's presence in the Dockerfile contract test.
- The process host provider runs without the image; the CLI remains invokable there as the Node
  entry point. Record the `pi-orb` shim in the runtime tool baseline in `docs/host-provider.md`.
- E2E (`e2e/full-slice.e2e.test.ts`): mint via `docker exec … pi-orb id-token`; an in-test fake
  relying party verifies the signature against the served JWKS and rejects wrong issuer,
  audience, project, orb, incarnation, and expiration; the existing
  stale-bearer-after-replacement leg extends to prove the old incarnation cannot mint; a stopped
  orb is denied. This stage touches runtime-facing routes, so `npm run test:e2e` gates it
  (`docs/testing.md`).

Stage 3 landed 2026-08-21. The transport sits behind an `IdTokenEndpoint` port so argument
validation, the bounds checks, and the retry policy are unit-testable without a network, mirroring
the `gh` helper's split; the exit-code contract and the `set -x` exposure warning live in the CLI's
own header text. The E2E additions ride on the existing compute-replacement fixture rather than
creating another orb: the running incarnation mints through `docker exec … pi-orb id-token` and an
in-test relying party (`e2e/harness.ts`) verifies it with `node:crypto` alone — following the
discovery document's advertised `jwks_uri`, matching the JWK by `kid`, and checking issuer,
audience, `token_use`, and expiry — with wrong-audience, wrong-issuer, and truncated-signature
rejections proving the verifier is not a rubber stamp. The same leg then covers a custom
`--ttl-seconds`, the locally rejected `--ttl-seconds 10` (nonzero exit, empty stdout), a stopped
orb's 403 `not_mintable` with the retained bearer plus the resulting user-visible identity status,
the discarded incarnation's 401 beside the existing broker 401, and the replacement incarnation's
successful mint carrying `host_incarnation=1`. The `docker exec` legs are Docker-only, like the
suite's other container-shell steps.

### Stage 4 — cloud deployment and federation

- `infra/run.tf`: a fourth Cloud Run service with `PI_ORB_ROLE=issuer`, public ingress, invoker
  IAM disabled — the first public unauthenticated surface, serving only discovery and JWKS. A
  tofu-managed parent secret for signing keys with accessor bindings for the minting service;
  `PI_ORB_OIDC_ISSUER_URL` in the shared environment. **This is now a hard boot requirement**: as of
  stage 2B the `runtime` and `issuer` roles refuse to start without it, so the deploy that ships
  stage 2B's control-plane image to Cloud Run must set it in the same change. `PI_ORB_ROLE` is
  likewise an allowlist now (`all | browser | runtime | ops | issuer`) and a typo refuses to boot.
- Workload Identity Federation bootstrap as a separately invoked script (the
  `bootstrap-amp-oidc.sh` tier, outside the recurring plan): pool and provider with exact issuer
  and audience, attribute mappings for `project_id`/`orb_id`/`host_incarnation`, the
  `token_use=exchanged` condition, and a read-only test grant.
- `infra/smoke-workload-identity.sh` invoked from `release.sh` beside the existing smokes: a
  disposable orb mints (via `gcloud compute ssh` plus `docker exec` on the GCE leg), exchanges
  through STS, calls a read-only GCP API, and proves wrong-audience and wrong-orb rejection.
- The generated external-account configuration and the GCP/AWS/generic verification recipes from
  the Federation integrations section above, including provider-side principal-to-orb
  correlation. `docs/deployment.md` and `docs/credentials.md` are updated in the same task, and
  this document's status header flips as stages land.

Stage 4 was implemented 2026-08-21 (`infra/oidc.tf`, `infra/run.tf`, `infra/outputs.tf`,
`infra/bootstrap-pi-orb-oidc.sh`, `infra/smoke-workload-identity.sh`, `infra/release.sh`,
`infra/api.sh`, `scripts/pi-orb-gcp-identity`, `docs/workload-identity-recipes.md`). It has not
been applied to GCP. Six decisions taken while implementing it:

- **The issuer URL is computed, not configured.** A Cloud Run service cannot reference its own
  `.uri`, so the runtime service — which mints and therefore needs `iss` at boot — cannot be handed
  the issuer's URL by ordinary reference. `local.oidc_issuer_url` in `infra/oidc.tf` instead builds
  the URL Cloud Run v2 assigns deterministically to a new service,
  `https://<service>-<project-number>.<region>.run.app`, from `data.google_project`. Both services
  read the same local, so one apply cannot ship a minting image without the matching issuer
  identity — which is exactly the stage 2B hazard, structurally removed rather than documented as a
  checklist item. Rejected: an operator-supplied variable (a hand-copied trust anchor whose drift
  is silent, and one more thing a release can forget) and a two-phase apply (machinery, plus a
  window in which the two services disagree about who the issuer is). The assumption is not taken
  on faith: the issuer service carries a `lifecycle.postcondition` asserting `self.uri` equals the
  computed local, so a platform that stopped assigning that URL form fails the release instead of
  deploying an issuer nobody can resolve. The three older services predate the deterministic scheme
  and still carry hashed URLs, which is why this is only sound for a service created now.
- **The public issuer runs as its own service account.** The requirement is that the issuer holds
  no signing material, but all three existing services share one `pi-orb-control-plane` account
  that can read every brokered credential — so simply not granting the new secret to "the control
  plane" would have granted it to the public service anyway. `google_service_account.issuer` can
  read exactly one secret (the database URL, for the *public* JWKs in `oidc_signing_keys`) and
  write logs. The signing-key grants name only the control-plane account. Splitting `browser`/`ops`
  off that account is separate pre-existing work; what stage 4 required was that "unauthenticated"
  and "can read private keys" never be the same identity. That separation is a Secret Manager
  boundary and stops there (POC limitation, recorded 2026-08-22): the database URL it reads is the
  deployment's single full read/write application credential, so at the PostgreSQL layer the public
  issuer holds the same rights as every other service — only its route allowlist keeps it to two
  public documents. A read-only PostgreSQL role for the issuer is tracked in `TODO.md`.
- **The parent secret is `pi-orb-credential-oidc-signing-key`**, not the prettier
  `pi-orb-oidc-signing-key`. `GsmSecretStore` addresses `<prefix>-<provider>` with the prefix
  defaulting to `pi-orb-credential`, and `domain/signing-keys.ts` writes under provider
  `oidc-signing-key`; any other name is simply not found at runtime. Both the Codex and GitHub
  credential bindings are mirrored: `secretAccessor` for the signer's per-signature read of an
  exact version, `secretVersionManager` for `addSecretVersion` on generation and
  `destroySecretVersion` when a boot-race loser drops an unreferenced version.
- **The issuer service's environment is trimmed to `PI_ORB_ROLE`, `PI_ORB_OIDC_ISSUER_URL`, and
  `DATABASE_URL`**, with every omission from `local.shared_env` commented in place. Leaving
  `PI_ORB_SECRET_STORE` unset means the process never even constructs a Secret Manager client;
  leaving `PI_ORB_HOST_PROVIDER` unset also keeps the GCE digest-pin boot gate off a service that
  creates no compute. Scaling stays capped at one instance: on the deployment's only public
  unauthenticated endpoint that cap is the spend bound, and `public, max-age=300` on both documents
  means a whole verifier fleet costs one request per key set per five minutes.
- **The smoke uses two orbs.** Proving "a stopped orb cannot mint" needs both a stopped orb and a
  caller that can reach the internal-ingress runtime service — and a stopped orb has no compute
  left to be that caller. The second orb boots concurrently with the first, so it costs a VM and
  almost no wall clock, and it probes with the stopped orb's bearer read from GCE instance
  metadata. Rejected: probing during `stopping` from the orb's own VM (the state that is both
  non-mintable and still running is a race, and a live smoke may not be flaky), and probing the
  runtime service directly from the release machine (internal ingress makes it unreachable, and a
  reachability flag would have gated a required check behind an environment variable).
- **The federation legs degrade, the mint and revocation legs do not.** `PI_ORB_SMOKE_WIF_*` unset
  means the WIF tier has not been bootstrapped, which is the expected state before
  `infra/bootstrap-pi-orb-oidc.sh` runs; the smoke then still mints in a real orb, still verifies
  against the deployed issuer's discovery and JWKS, and still proves stopped-orb and unknown-bearer
  refusal — it just cannot claim GCP accepts the token, and says so loudly.

## Non-goals

- Browser sign-in, user authentication, project ownership, or multiplayer authorization.
- A pi-orb-managed universal cloud permission model.
- Immediate revocation of already-issued offline-verifiable JWTs or downstream sessions.
- Storing cloud service-account keys, access keys, client secrets, or renewable credentials in an
  orb.
- Automatically granting every project or orb access to a cloud account.
- Replacing the model/GitHub credential broker: those flows protect renewable user credentials and
  have different semantics.
- Replacing provider bootstrap identity, host lifecycle fencing, or Tailscale port identity.
