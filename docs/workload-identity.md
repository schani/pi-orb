# Orb workload identity

Code in an orb proves which pi-orb deployment, project, orb and compute incarnation it is with a
short-lived signed OIDC token. Relying parties verify it and decide what it may do; cloud
federation exchanges it for provider credentials. pi-orb stores no cloud secret and grants nothing
by itself.

This authenticates code, not a person. Long-lived keys in project secrets are the wrong primitive:
every orb process can read them, they outlive the compute, and rotation is fleet-wide
distribution. The design follows Amp's orb OIDC ([Amp OIDC](https://ampcode.com/manual/orbs/oidc)).

Step-by-step GCP, AWS and generic setup lives in the in-orb skill
`apps/orb-runtime/skills/cloud-identity/SKILL.md`. Its primary GCP path runs the admin sequence
inside the orb under a temporary human `gcloud auth login` in the Terminal tab, proves federation
with an isolated empty `CLOUDSDK_CONFIG`, then revokes that login. Trade-off: during setup the
human's refresh token sits in the orb's persistent home, readable by every orb process, so the
revoke is part of the flow, not cleanup. The alternative is a finished block for the human's own
machine.

## Identity

Authoritative identity comes only from control-plane state:

- **issuer**: the deployment's configured issuer URL;
- **project**: immutable project ID;
- **orb**: immutable orb ID;
- **incarnation**: the monotonic `host_incarnation` currently authorized.

Repository URL, names, Git author, email, host reference and cloud VM identity are not
authorization identities. Bootstrap proof is the runtime incarnation bearer (`docs/credentials.md`);
possession means "code in this incarnation", not "the human who created the orb".

### Token claims

| Claim | Value |
| --- | --- |
| `iss` | exact issuer origin |
| `aud` | exact non-empty requested audience, ≤ 512 UTF-8 bytes |
| `sub` | orb ID |
| `iat`, `exp` | control-plane clock; default 600 s, range 60–3600 s |
| `jti` | unique random ID |
| `project_id` | project ID |
| `orb_id` | orb ID |
| `host_incarnation` | current incarnation (JSON number) |
| `token_use` | `exchanged` |

No `user_id`, email, workspace, cloud account, role or permission claim. A server-derived user
claim would need a deliberate decision (question 25 in `docs/open-questions.md`); existing relying
policies must keep failing closed if one is added. Relying parties that need the owner, such as
pi-orb itself, derive it server-side from `orb_id`.

## Relying-party rules

A verifier must check:

1. signature against the JWKS key matching the header `kid`; RS256 only, never the token's own
   `alg` choice;
2. `iss` exactly equal to the configured issuer (string comparison, no trailing-slash tolerance,
   never from a request header);
3. `aud` exactly equal to its own audience;
4. `iat`/`exp` with at most 60 s skew;
5. `token_use == "exchanged"`;
6. the identity claims of the grant.

Follow `jwks_uri` from discovery, require it under the issuer origin, cache the set and refetch on
an unknown `kid`.

**Why relying-party trust must bind identity claims.** The audience is not a secret: any orb of the
deployment may request any audience. A party checking only `iss` and `aud` has authorized every orb
of the deployment. Grants therefore match `project_id` (project-wide), `project_id` + `orb_id`
(one orb), or additionally `host_incarnation` (one compute). Preventing code in an orb from minting
that orb's identity is not a goal; limiting what the identity can do is the relying party's job.

Provider expressiveness:

- **GCP** can bind every claim through Workload Identity Pool attribute mappings. The mapping must
  cast `string(assertion.host_incarnation)`; GCP evaluates the whole mapping on every exchange, so
  an uncast number fails all exchanges. `infra/bootstrap-pi-orb-oidc.sh` is the reviewed bootstrap
  (refuses an unscoped pool without `ALLOW_ANY_ORB=1`); `scripts/pi-orb-gcp-identity`, baked at
  `/usr/local/bin/pi-orb-gcp-identity`, is the executable credential source. Set
  `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` only around callers that use it.
- **AWS** trust policies for a self-registered OIDC provider can condition only on `aud` and `sub`.
  A one-orb grant matches `sub`; a project-wide grant is not expressible except by enumerating orbs
  or a verify-and-vend service. An `aud`-only policy admits every orb of the deployment.
- Downstream audit logs are the forensic trail: GCP shows `subject/<orb UUID>`; AWS sessions should
  name the orb.

An already-issued token cannot be revoked; its expiry bounds residual access. Downstream sessions
may live longer, so request the shortest supported session.

pi-orb is itself a relying party for audience `urn:pi-orb:access`: preview and files hosts check
rules 1–5 locally against the published keys and admit same-owner access derived from `orb_id`
(`docs/http-exposure.md`).

## CLI

```text
pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]
```

Implemented in `apps/orb-runtime/src/id-token/` behind the `pi-orb` dispatcher
(`/usr/local/bin/pi-orb`; on `PATH` for process hosts, `docs/host-provider.md`).

- Success prints only the JWT and a newline. Nothing goes to stderr; the JWT is never cached.
- Arguments (`--flag value` or `--flag=value`) and bounds are validated before any request.
- No interactive login, browser or project secret. Shell tracing around the command exposes the
  token.
- Repository setup must never download an unreviewed credential helper.

| Exit | Class |
| --- | --- |
| 0 | token printed |
| 2 | usage, or no orb runtime environment |
| 3 | unauthorized: bearer refused |
| 4 | not mintable: lifecycle forbids identity |
| 5 | rate limited |
| 6 | unavailable: control plane unreachable or transient |
| 7 | internal: control-plane bug, retry cannot help |

The CLI retries only the first-boot 401, the rate floor and transient failures, within one 10 s
budget using 250 ms/2 s backoff. It honors `Retry-After` but never sleeps past the budget.
`not_mintable`, `invalid_request` and `internal` return on the first response. Each attempt's
transport timeout is the remaining budget, covering headers and body; carving the budget into
short attempts abandoned requests queued behind cold starts
(`docs/postmortems/2026-09-08-identity-cold-start.md`). Timeout is typed `retryable`; mid-body
timeout differs from malformed JSON.

Each invocation generates a random 128-bit trace shared by its retries, with a distinct span per
attempt in `X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=0`, so Cloud Run request logs correlate
same-invocation 429 → 200. Generation failure returns `internal`.
`PI_ORB_ID_TOKEN_DIAGNOSTICS=1` emits a token-free JSON allowlist on stderr: attempt, elapsed and
remaining ms, result kind, retry hint, chosen wait and budget exhaustion.

## Mint path

The CLI calls the control plane directly with the bearer, like the `gh` helper. The bearer goes
only to the control plane, never to a relying party. Rejected: a loopback runtime hop, which adds
no boundary since every orb process already has the bearer.

```text
POST /runtime/v1/id-token
Authorization: Bearer <runtime bearer>
request  { "audience": string, "ttlSeconds"?: number }
200      { "token": string }                Cache-Control: no-store
400 invalid_request | 401 unauthorized | 403 not_mintable
429 rate_limited (Retry-After) | 503 retryable | 500 internal
```

Error envelope: `{error, message?, retryAfterMs?}` (`packages/protocol/src/workload-identity.ts`).
`unauthorized` covers unknown, stale and fenced bearers identically, revealing nothing about other
orbs. `internal` is distinct from `retryable` so clients never retry a deterministic bug
(`docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`).

1. The route hashes the bearer and passes it to `mintIdToken` (`domain/workload-identity.ts`)
   without pre-authenticating, because the domain's read is the linearization point.
2. One snapshot read of the orb row checks bearer hash, absence of a discard fence and state in
   `MINT_STATES` = `creating | starting | running`. A lifecycle change committed before the read
   denies; a mint that read first stays valid even if its response arrives later.
3. `claimMintSlot` atomically moves `orbs.last_mint_at` only if the previous mint is at least 2 s
   old. The claim is the check, so exactly one racer wins. It bumps no state version. A slot
   consumed by a failed signature is not refunded, so a signer outage cannot become a retry storm.
4. Claims come only from the row; nothing from the request, repository, host metadata or env.
5. Sign and return. Neither side persists the token.

`MINT_STATES` is narrower than the broker's `RUNTIME_TOKEN_STATES`: `stopping`, `stopped`,
`failed`, `archiving`, `archived`, `deleting` and missing orbs cannot mint, so Stop closes minting
before shutdown. Stop/start of a retained incarnation keeps its bearer, which cannot mint while
stopped. Replacement rotates the bearer and advances the incarnation; the old one can never
mint for the new one. Archive and deletion revoke minting before destructive cleanup. One orb can
never mint another orb's identity.

Host providers never implement OIDC or hold keys; they only inject URL, orb ID, incarnation and
bearer as before.

Bounds: request body, audience length, lifetime, signing concurrency and response size. Arbitrary
syntactically valid audiences are allowed. Never put a JWT in a URL, argument beyond the CLI
output, event detail, exception, metric label, trace attribute or test snapshot. Per-orb
throttling only; a deployment-wide limit was rejected.

## Issuer and keys

- `PI_ORB_OIDC_ISSUER_URL` is canonicalized to a bare origin and validated before boot side
  effects; a path, query, fragment or credentials are refused. HTTPS is required except for
  loopback; local auth defaults to `http://127.0.0.1:<port>`, Google mode requires it explicitly.
  The issuer URL is the trust identity and never derives from request headers.
- In cloud the issuer is the application's deterministic Cloud Run origin, computed by OpenTofu and
  gated at release; moving it is a federation trust cutover (`docs/deployment.md`).
- `GET /.well-known/openid-configuration` advertises `response_types_supported: ["id_token"]`,
  `subject_types_supported: ["public"]`, `id_token_signing_alg_values_supported: ["RS256"]` and
  the claims; always 200 `public, max-age=300`, even before a key exists.
- `GET /.well-known/jwks.json` serves `pending`, `active` and `retired` keys within the overlap
  window, active first, `public, max-age=300`. Zero keys or any store failure (including a missing
  table) answer uncached `503 {"error":"unavailable", ...}` with a fixed body, never a cacheable
  empty set and never a raw store message.
- Signing, JWK export and RFC 7638 `kid` thumbprints are first-party `node:crypto` code behind a
  signer port (`adapters/oidc/`; rationale in `docs/stack.md`). RS256, 2048-bit RSA.

Keys: `oidc_signing_keys` rows (`kid`, exact secret version, public JWK, state
`pending | active | retired`, timestamps, row-version CAS); at most one active. Private PKCS#8 keys
live only in the secret store under provider `oidc-signing-key` (Secret Manager parent
`pi-orb-credential-oidc-signing-key`), never in orbs, images, PostgreSQL, logs or source.

- **Material cache.** The active row is read per signature; private material is cached by `kid`
  and version and revalidated after 60 s, which bounds revocation by destroying a version.
  Unreadable material fails closed with a typed retryable error, never an unsigned token, another
  deployment's key or a static token. Rotation never requires restarting orbs.
- **Boot.** `ensureActiveSigningKey` runs after `listen`, fire-and-forget with bounded retries,
  and never fails the boot: the application is also the credential broker. It prefers activating a
  published `pending` key; with no key it generates one and inserts it directly `active`. Racing
  instances collide on the unique-active index; the loser adopts the winner and destroys its own
  version only when its row is provably absent. The candidate and acknowledged version are owned
  across the outer retry lifetime; a candidate whose destruction was attempted is never published
  (`docs/postmortems/2026-09-05-signing-key-bootstrap-orphans.md`). Success requires reading the
  material once.
- **Rotation** (ops, application-authenticated): `POST /api/v1/issuer/signing-keys/publish` adds a
  `pending` key to JWKS; `POST /api/v1/issuer/signing-keys/activate` retires the old key and
  activates the new one. Activate returns 409 while the newest key is younger than 10 minutes
  (twice JWKS max-age) unless `{"force": true}` (leaked-key emergency). Retirement is fenced to the
  `(kid, rowVersion)` active when rotation started; a conflicting rotation adopts the other's
  outcome. A retired key never returns to active. The brief no-active window fails minting closed
  until the next ensure or rotation.
- **Overlap.** Retired keys stay published for max lifetime + 5 minutes. Rows and versions are kept
  afterwards; their deletion is a `TODO.md` item.

Constants: `IssuerConstants` in `apps/control-plane/src/domain/constants.ts`.

## Observability

- The control plane persists nothing about a mint failure; the caller gets the typed error and exit
  code in its transcript. Only `last_mint_at` (the rate floor) is stored. Rejected: persisted
  last-failure columns and an orb-page banner, which went stale after recovery.
- `identity-mint-denied` lifecycle edge: orb ID, incarnation and code (`not_mintable`,
  `rate_limited`, `invalid_request`, `signer_failure`, `store_unavailable`), never audience, bearer
  or token. Deduplicated per process per orb per code until a success or code change
  (`MintDenialLog`). `unauthorized` resolves to no orb and is not logged per orb.
- Key edges: `issuer-key-unusable`, `issuer-key-unavailable`, `issuer-key-race-lost`,
  `issuer-key-cleanup-failed`.
- Healthy minting logs nothing. No per-mint audit table: pi-orb cannot enumerate what it minted;
  provider audit logs carry that trail.

## Verification

DST (`workload-identity.dst.test.ts`, `signing-keys.dst.test.ts`) covers: mint in each allowed
state and denial in others; stop, replacement, archive/delete and discard-fence races against mint;
first-boot pre-commit retry; signer failure and recovery; rate-floor writes against lifecycle CAS;
concurrent mints across instances; denial-edge dedup; key rotation and boot races; clock and TTL
bounds; cross-orb use. The in-memory key store enforces the schema's timestamp checks; both drivers
run the contract. The E2E relying party (`e2e/harness.ts`) verifies against served JWKS and
rejects wrong issuer, audience, project, orb, incarnation, expiry and signature. The release smoke
is `infra/smoke-workload-identity.sh` (`docs/deployment.md`).

## Non-goals

- A pi-orb-managed cloud permission model or automatic cloud access for any project or orb.
- Immediate revocation of issued JWTs or downstream sessions.
- Storing cloud keys, client secrets or renewable credentials in an orb.
- Replacing the model/GitHub broker or provider bootstrap identity.
