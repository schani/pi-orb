# Workload identity federation recipes

> **Status:** Written 2026-08-21 with stage 4 of `docs/workload-identity.md`. The GCP recipe is
> the one the repository exercises end to end (`infra/bootstrap-pi-orb-oidc.sh`,
> `infra/smoke-workload-identity.sh`); the AWS and generic recipes are reviewed guidance that has
> not yet been run against a live account.
>
> **Review pass 2026-08-22**, still against no live account, corrected two things this document had
> wrong. The GCP attribute mapping must cast the numeric `host_incarnation` claim with `string()`
> or *every* exchange fails, and the AWS section documented a role trust policy that no principal
> can satisfy — AWS exposes only a fixed set of condition keys for a self-registered OIDC provider,
> and pi-orb's custom claims are not among them. Both are corrected below; the AWS section's
> conclusion changed, not just its syntax.

Requirements, the trust model, and the claim contract live in `docs/workload-identity.md`. This
document is the *integration* side: how a relying party configures itself to accept a pi-orb orb's
identity, and how a workload inside an orb hands that identity to an SDK. Operating pi-orb's own
issuer tier — the Cloud Run service, the bootstrap script, the release smoke — is in
`infra/README.md`.

## What an orb presents

Inside any running orb:

```sh
pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]
```

It prints an RS256-signed JWT and nothing else. The token names the orb, not a person:

| Claim | Meaning |
| --- | --- |
| `iss` | the pi-orb deployment's public issuer origin |
| `aud` | exactly the audience the caller asked for |
| `sub` | the orb ID — compact, immutable, and the natural provider subject |
| `project_id` | the pi-orb project ID (immutable) |
| `orb_id` | the pi-orb orb ID (immutable, equals `sub` today) |
| `host_incarnation` | the compute incarnation currently authorized for the orb |
| `token_use` | always `exchanged` |
| `iat`, `exp`, `jti` | issued-at, expiry (ten minutes by default), unique token ID |

There is deliberately no `user_id`, `email`, or `workspace_id`, and no role or permission claim.

### The audience is not authorization

Any orb of a pi-orb deployment may request any audience. A relying party that checks only `iss`
and `aud` has authorized **every orb of that deployment**, including orbs created by someone else
for an unrelated project. Every recipe below therefore constrains at least one immutable identity
claim:

- **project-wide grant** — match `project_id`;
- **one-orb grant** — match `project_id` *and* `orb_id`;
- **incarnation-sensitive grant** — additionally match `host_incarnation`.

Nothing else in the token is an authorization identity. Names, repository URLs, Git authors, and
host references are mutable or caller-influenced.

Which of those three a relying party can *express* depends on the relying party. GCP can express
all of them, because a workload identity pool maps arbitrary claims into condition attributes. AWS
can express only the one-orb form, and only by `sub` — see the AWS section, which is where that
limit and its workarounds are documented rather than discovered.

### What a relying party must verify

1. the signature, against the key in the issuer's JWKS whose `kid` matches the JWT header;
2. `iss` exactly equal to the configured issuer origin — string comparison, no normalization, no
   trailing-slash tolerance, and never derived from a request header;
3. `aud` exactly equal to the audience this relying party issued;
4. the current time inside `iat`/`exp` with **at most 60 seconds** of clock skew in either
   direction (the default lifetime is 600 s, so a larger allowance is a meaningful extension of
   every token's life);
5. `token_use == "exchanged"`;
6. the project and/or orb claims the grant is scoped to.

Discovery lives at `<issuer>/.well-known/openid-configuration` and names the `jwks_uri`. Both
documents are public, contain no secret, and are served `public, max-age=300`. Follow the
`jwks_uri` from discovery rather than hardcoding it, but require it to be under the issuer origin.
Cache the key set and refetch on an unknown `kid`: pi-orb publishes a rotating key *before* signing
with it and keeps a retired key published for the maximum token lifetime plus five minutes, so a
verifier that refreshes on cache miss never sees a signature it cannot check.

An already-issued token cannot be revoked. Stopping an orb stops new tokens immediately; the
expiry bounds the ones already out. Downstream sessions inherit their own lifetime, so ask for the
shortest one the provider supports.

## Google Cloud

### 1. Bootstrap the pool and provider (once, by an administrator)

`infra/bootstrap-pi-orb-oidc.sh` is the reviewed, idempotent form of this. It creates a workload
identity pool, an OIDC provider bound to the exact issuer URL and audience, the attribute mapping,
the `token_use`/identity attribute condition, and a read-only test service account:

```sh
PI_ORB_TRUSTED_PROJECT_ID=<pi-orb project UUID> \
  ./infra/bootstrap-pi-orb-oidc.sh --dry-run     # review
PI_ORB_TRUSTED_PROJECT_ID=<pi-orb project UUID> \
  ./infra/bootstrap-pi-orb-oidc.sh
```

The mapping it installs, and the reason for each entry:

```text
google.subject          = assertion.sub               # the orb ID; what audit logs show
attribute.project_id    = assertion.project_id        # project-wide grants bind to this
attribute.orb_id        = assertion.orb_id            # one-orb grants bind to this
attribute.host_incarnation = string(assertion.host_incarnation)
```

The `string()` is load-bearing, not decoration. `host_incarnation` is a JSON **number** in the
token, every mapped attribute must evaluate to a string, and GCP evaluates the *whole* mapping on
*every* exchange — so an unconverted number does not merely make incarnation-scoped policies
unusable, it fails every exchange with `The mapped attribute must be of type STRING`, including
exchanges whose policy never mentions the incarnation. The attribute *condition* below needs no
cast: it compares `assertion.*` values directly, not mapped attributes.

and the attribute condition, which is the provider-side half of authorization:

```text
assertion.token_use == 'exchanged' && assertion.project_id == '<pi-orb project UUID>'
```

The script refuses to run with no identity scope at all unless `ALLOW_ANY_ORB=1` is passed
deliberately, because a pool admitting every orb is the mistake this section exists to prevent.

### 2. Grant something narrow

Prefer direct federated access where the API supports it; otherwise grant the workload
`roles/iam.workloadIdentityUser` on a service account that itself holds only the roles the workload
needs. Bind the principalSet as narrowly as the grant is meant to be:

```sh
# every orb of one pi-orb project
principalSet://iam.googleapis.com/projects/<N>/locations/global/workloadIdentityPools/<pool>/attribute.project_id/<pi-orb project UUID>

# exactly one orb
principalSet://iam.googleapis.com/projects/<N>/locations/global/workloadIdentityPools/<pool>/attribute.orb_id/<orb UUID>
```

Start with a read-only role. `infra/bootstrap-pi-orb-oidc.sh` defaults its test account to
`roles/browser` precisely so proving the mechanism works cannot itself grant anything interesting.

### 3. Generate the external-account configuration (inside the orb)

The configuration contains **no secret**. Its executable credential source is
`scripts/pi-orb-gcp-identity`, a reviewed wrapper that runs `pi-orb id-token` and prints Google's
executable-source envelope. Generate it with gcloud:

```sh
export PI_ORB_GCP_AUDIENCE='urn:pi-orb:gcp:<gcp project>'
gcloud iam workload-identity-pools create-cred-config \
  projects/<N>/locations/global/workloadIdentityPools/<pool>/providers/<provider> \
  --service-account=<test or workload SA>@<gcp project>.iam.gserviceaccount.com \
  --executable-command="$PWD/scripts/pi-orb-gcp-identity" \
  --subject-token-type=urn:ietf:params:oauth:token-type:id_token \
  --output-file="$HOME/.pi-orb-gcp.json"
chmod 600 "$HOME/.pi-orb-gcp.json"
```

Without gcloud, the same file is a short heredoc:

```sh
cat > "$HOME/.pi-orb-gcp.json" <<JSON
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/<N>/locations/global/workloadIdentityPools/<pool>/providers/<provider>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<sa email>:generateAccessToken",
  "credential_source": {
    "executable": {
      "command": "$PWD/scripts/pi-orb-gcp-identity",
      "timeout_millis": 30000
    }
  }
}
JSON
chmod 600 "$HOME/.pi-orb-gcp.json"
```

Then, **only around the callers meant to federate**:

```sh
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.pi-orb-gcp.json"
export PI_ORB_GCP_AUDIENCE='urn:pi-orb:gcp:<gcp project>'
export GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1
```

`GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` is a global switch that lets *any* credential file
the process loads execute *any* program it names. Scope it to the shell, service unit, or process
that uses the reviewed helper; do not put it in a machine-wide profile. Repository setup must never
download an unreviewed credential helper — the helper and the CLI are both in this repository, and
that is the point.

### 4. Correlating back to the orb

`google.subject` is the orb ID, so Cloud Audit Logs show
`principal: principal://iam.googleapis.com/.../subject/<orb UUID>` and, on impersonated calls, the
delegation chain ending at the service account. A misused token therefore identifies its orb from
the provider's side, which is the forensic trail pi-orb deliberately does not keep itself
(`docs/workload-identity.md`, "Observability and failure visibility").

## AWS

> AWS is **more restrictive than GCP here, and the difference changes what is expressible.** A
> workload identity pool provider maps arbitrary claims into attributes that IAM conditions and
> principalSets can bind to. AWS has no equivalent: for a self-registered OIDC provider, role trust
> policies may condition only on a fixed allowlist of keys — `<issuer host>:aud`, `:sub`, and the
> provider-specific `:amr`, `:oaud`, `:email` that only Amazon's built-in identity providers
> populate. pi-orb's `project_id`, `orb_id`, `host_incarnation`, and `token_use` are simply not
> available as condition keys, and a `StringEquals` on a key that is not present evaluates **false**
> — so a policy naming them is not "extra safety", it is a role nobody can assume. Read the whole
> section before writing a trust policy; the shape that works is narrower than the GCP one.

### 1. Register the issuer as an IAM OIDC provider

```sh
aws iam create-open-id-connect-provider \
  --url '<issuer origin>' \
  --client-id-list 'urn:pi-orb:aws:<account>:<role name>'
```

The `--client-id-list` entries are the audiences AWS accepts for this provider, and they are the
`aud` values orbs must request. Prefer a distinct audience string per AWS role over the generic
`sts.amazonaws.com`: audience is the only per-integration lever AWS gives you here, so spending it
on a shared constant wastes it. Add audiences to an existing provider with
`aws iam add-client-id-to-open-id-connect-provider`.

### 2. Role trust policy — what AWS can actually check

The whole authorization is `sub` plus `aud`. `sub` is the **orb ID**, which is the only pi-orb
identity AWS can see:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/<issuer host>" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "<issuer host>:aud": "urn:pi-orb:aws:<account>:<role name>",
        "<issuer host>:sub": "<orb UUID>"
      }
    }
  }]
}
```

`<issuer host>` is the issuer URL without its scheme, exactly as the provider ARN spells it. Several
orbs are a JSON array of `sub` values under the same key. AWS supports `StringLike` — resist it on
`sub`: pi-orb orb IDs are random UUIDs, so a wildcarded prefix is not a boundary, it is a wider
grant that looks narrow.

**A project-wide grant is not expressible on AWS today.** `project_id` is not a condition key, and
nothing else in the token carries the project. Three honest options, in the order to prefer them:

1. **Enumerate the orbs.** Keep the `sub` list current in the trust policy. Correct, immediate, and
   the operational cost is real: an orb is a disposable object in pi-orb, so a long-lived AWS role
   granted to a specific orb has to be re-pointed whenever that orb is replaced by a new one.
2. **A per-role audience, accepted deliberately.** Issue one audience string per AWS role
   (`urn:pi-orb:aws:<account>:<role>`) and condition only on `aud`. Understand exactly what this
   buys: **the audience is not a secret and not an authorization boundary** — any orb of the pi-orb
   deployment can request any audience, so an `aud`-only trust policy grants that role to *every
   orb of the deployment*, whoever created it and for whatever project. That is the same posture as
   `ALLOW_ANY_ORB=1` on the GCP side, and it is defensible only where every orb of the deployment is
   equally trusted for that role. Never describe it as project scoping; it is deployment scoping.
   Pair it with the `sub` condition wherever the grant is meant to be narrower.
3. **Verify the token yourself and vend credentials.** A small relying service (Lambda + API
   Gateway, or any service following the generic recipe below) can check `project_id`, `orb_id`,
   `host_incarnation`, and `token_use` properly and then call `sts:AssumeRole` on the workload's
   behalf. This is the only way to get pi-orb-project-scoped AWS access with the full claim set
   enforced, at the cost of a service to run.

`token_use` is likewise uncheckable at AWS. Every pi-orb token is `token_use=exchanged` today, so
nothing is lost right now — but if pi-orb ever mints a second token class, AWS trust policies will
not be able to tell them apart, and option 3 becomes the only safe form.

### 3. Assume the role from inside the orb

AWS SDKs read the web-identity token from a *file*, so the token briefly touches disk. Keep it
mode-0600, short-lived, and out of shell history:

```sh
umask 077
token_file=$(mktemp "${TMPDIR:-/tmp}/pi-orb-web-identity.XXXXXX")
trap 'rm -f "$token_file"' EXIT INT TERM HUP
pi-orb id-token --audience 'urn:pi-orb:aws:<account>:<role name>' > "$token_file"

export AWS_ROLE_ARN='arn:aws:iam::<account>:role/<role>'
export AWS_WEB_IDENTITY_TOKEN_FILE="$token_file"
export AWS_ROLE_SESSION_NAME="pi-orb-$(hostname)"
aws sts get-caller-identity
```

Rules that go with it:

- **Never** paste the token into a command line: `aws sts assume-role-with-web-identity
  --web-identity-token <jwt>` puts a live credential in `~/.bash_history`, in `ps` output, and in
  any CI log that echoes commands. Redirect into the file instead, as above.
- Request the shortest session the role allows (`--duration-seconds 900` is the minimum) and set
  the role's `MaxSessionDuration` to match. The session outlives the JWT, and it is what an
  attacker gets if it leaks.
- Delete the token file when the process ends — the `trap` above, not a manual step.
- The SDK re-reads `AWS_WEB_IDENTITY_TOKEN_FILE` on refresh, so a long-running process needs the
  file rewritten before the JWT expires, or a fresh process per session.
- The audience must be one of the provider's client IDs *and* match the trust policy's `aud`
  condition. A mismatch is refused by STS, which is the intended failure — but note it is refused
  for the audience, not for the orb's identity, so a passing `get-caller-identity` proves the
  audience matched, never that AWS checked which orb you are.
- Set `AWS_ROLE_SESSION_NAME` to something that names the orb; it appears in CloudTrail and is the
  AWS-side correlation back to pi-orb. It is caller-chosen, so it is a forensic breadcrumb, not an
  identity: the assumed-role ARN and the trust policy's `sub` condition are what actually bound the
  session.

## Generic OIDC relying services

Anything that can verify an OIDC ID token can accept a pi-orb identity. The minimum implementation:

1. Fetch `<issuer>/.well-known/openid-configuration` once at startup and on `kid` cache misses.
   Require `document.issuer == <configured issuer>` and `jwks_uri` under that origin.
2. Fetch and cache the JWKS. Honor `max-age`; refetch on an unknown `kid`; never fall back to a key
   from a different issuer.
3. Verify RS256 over `header.payload` with the matching key. Reject `alg: none` and any algorithm
   the discovery document does not advertise — accepting the token's own `alg` claim is the classic
   OIDC verification bug.
4. Check `iss`, `aud`, `token_use`, and `exp`/`iat` with ≤ 60 s skew.
5. Check the identity claims for the grant:

   ```text
   project-wide:  claims.project_id == "<pi-orb project UUID>"
   one orb:       claims.project_id == "<project UUID>" && claims.orb_id == "<orb UUID>"
   one compute:   ... && claims.host_incarnation == <n>
   ```

6. Treat `jti` as an idempotency/replay key if the operation needs one; pi-orb does not track it.

`infra/smoke-workload-identity.sh` embeds a ~60-line verifier that does exactly this against the
live issuer, and `e2e/harness.ts` contains the in-test relying party used by the E2E suite. Both
are readable reference implementations, and both deliberately reject wrong issuer, wrong audience,
wrong orb, wrong incarnation, expiry, and a tampered signature — a verifier that has never been
shown to *fail* has not been tested.

### Migrating an existing integration

The Tailscale control-plane OAuth flow in `docs/ports.md` does not change because OIDC exists.
Replacing a long-lived key with federation is separate work per integration, and each one must
preserve whatever bounding the old credential had.
