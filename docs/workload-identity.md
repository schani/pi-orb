# Orb workload identity requirements

> **Status:** Requirements accepted 2026-08-21; not implemented. This document defines a
> provider-neutral OIDC identity that code running inside a pi-orb can exchange for
> short-lived credentials from cloud providers and private services. It does not grant any
> permission by itself: each relying party owns its trust policy and authorization.

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
- return nonzero with a concise typed failure for unavailable runtime, unauthorized/stale
  incarnation, invalid request, rate limit, or issuer failure;
- support command substitution and executable credential-source protocols;
- never cache the JWT on disk;
- not require interactive login, a browser, or a project secret;
- document that shell tracing around the command exposes the returned token.

The CLI name describes the product interface. It may be implemented as a small executable in the
runtime image or as an orb-runtime subcommand, but repository setup must not download an
unreviewed credential helper.

## Orb integration

### Request path

The runtime bearer must not be sent to an external relying party. Token minting follows the
existing internal runtime-authentication boundary:

```diagram
┌────────────────┐    local command     ┌─────────────┐
│ Agent/project  │─────────────────────▶│ Orb runtime │
│ process        │                      └──────┬──────┘
└────────────────┘                             │ authenticated internal request
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
2. The local CLI asks its own orb runtime over a loopback-only endpoint or equivalent private IPC.
3. The runtime calls a versioned control-plane runtime endpoint with the existing per-incarnation
   bearer. The request includes only audience and requested lifetime; identity is never supplied
   by the runtime.
4. The control plane hashes and constant-time verifies the bearer, loads the orb, and derives all
   identity claims from that row.
5. It verifies that the bearer hash and requested incarnation are current, no discard fence covers
   the incarnation, and the orb is in a lifecycle state authorized to mint.
6. One store transaction rechecks the token hash, state version, incarnation, discard fence, and
   mint-authorized state, then durably records the successful decision. This transaction is the
   mint's linearization point relative to stop, replacement, archive, and delete.
7. It signs and returns a token with `Cache-Control: no-store`. Signing may occur before the
   authorization transaction if needed, but an uncommitted token is never returned.
8. The runtime returns the token to the one local request. Neither layer persists it.

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
per-incarnation bearer into the runtime's private launch channel. The runtime and control plane
compose the provider-neutral identity flow above.

Repository code is considered able to read the current runtime environment and invoke the local
CLI. Preventing code in an orb from minting that orb's identity is not a goal; limiting what that
identity can do belongs in relying-party policy. One orb must never mint another orb's identity.

## Issuer and signing requirements

- Expose an HTTPS OIDC discovery document at
  `/.well-known/openid-configuration` beneath a stable issuer URL and a public JWKS endpoint.
- Initially sign with RS256 for broad federation compatibility. Every JWT carries a `kid`.
- Keep private signing keys outside orb hosts, container images, PostgreSQL state, logs, and source
  control. In cloud deployment they live in a dedicated secret/KMS boundary readable only by the
  issuer service identity.
- Support overlapping key rotation: publish the new public key before signing with it, retain old
  public keys for at least the maximum JWT lifetime plus verifier cache/clock-skew allowance, then
  remove them. Rotation must not require restarting orbs.
- Discovery and JWKS are public, cacheable, and contain no secret. Token-mint responses are
  `no-store`.
- If signing material is unavailable, fail closed with a typed retryable error. Never fall back to
  an unsigned token, another deployment's key, or a long-lived static token.
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
- a subject/custom-claim policy scoped to the intended project/orb;
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
- Apply per-orb and deployment-wide mint rate limits. Return a typed retryable result and
  `Retry-After`; do not use exceptions for expected throttling.
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

## Observability and audit

Workload identity is security-sensitive and must be reconstructable without recording tokens.

- Persist one queryable audit record per mint decision containing: timestamp, project ID, orb ID,
  host incarnation, JWT ID or a one-way hash of it, exact bounded audience, requested/effective
  lifetime, signing key ID, outcome, and typed denial/error code.
- Never persist the JWT, runtime bearer, private key, or downstream cloud credential.
- Audit writes for successful minting must be committed before returning the JWT. If the durable
  audit sink is unavailable, minting fails closed rather than creating unaudited authority.
- Denials caused by expected stale/stopped callers are rate-limited in operational logs, while the
  durable audit record remains queryable. Healthy minting must not create noisy lifecycle events.
- Key activation/retirement, signer unavailability edges, sustained throttling, and policy/config
  changes produce durable operator-visible security events.
- The CLI reports actionable failures to the orb user. A dashboard/API identity status must expose
  issuer readiness and the latest non-secret mint failure for that orb; a silent refusal is not
  acceptable.
- Downstream provider audit logs remain part of the end-to-end trail. Recipes must explain how to
  correlate their delegated principal/session with pi-orb's orb, incarnation, and JWT audit ID.

## Deterministic verification requirements

Concurrency-critical issuance and revocation must sit behind simulation-friendly clock, random,
signer, audit-store, and orb-store ports. Deterministic scheduling tests must cover at least:

- valid mint from each allowed lifecycle state;
- denial in every disallowed state;
- stop racing mint, proving no mint decision linearizes after durable mint authority closes (a
  mint that linearized first remains valid even if its HTTP response arrives after the stop);
- compute replacement racing mint, proving the old bearer cannot mint the new incarnation;
- archive/delete and discard-fence races;
- first-boot request before bearer-hash commit followed by bounded successful retry;
- signer failure, audit-write failure, and recovery without an unaudited token;
- rate-limit races across control-plane instances;
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
5. Every mint decision has a durable non-secret audit record, and user-visible failures explain
   why identity is unavailable.
6. Provider implementations remain unaware of OIDC and all supported host providers pass the same
   contract tests.
7. The deterministic race suite and full runtime E2E pass, including stop/replacement revocation
   boundaries.

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
