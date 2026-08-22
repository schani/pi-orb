---
name: cloud-identity
description: Obtain short-lived cloud credentials (GCP, AWS, generic OIDC) inside this orb with `pi-orb id-token`, pi-orb workload identity — no stored secret, no service-account key, no interactive login. Use when a task needs gcloud, Google Cloud APIs, AWS APIs, or authenticated access to a private service that trusts an OIDC identity, and when a cloud call fails with missing, expired, or absent credentials.
---

# Cloud identity from inside an orb

You are running inside a pi-orb orb. The orb can prove *its own* identity to a
cloud provider, so you can obtain short-lived cloud credentials with no secret
stored anywhere on this machine.

## The primitive

```sh
pi-orb id-token --audience <audience> [--ttl-seconds 60..3600]
```

It prints one RS256-signed JWT and a trailing newline to stdout and nothing
else, so command substitution and executable credential sources can consume it
directly. Default lifetime is ten minutes. The token is never cached on disk.

The claims prove **which orb is calling**: `sub` and `orb_id` (this orb),
`project_id` (the pi-orb project), `host_incarnation` (the compute currently
authorized for the orb), `token_use: "exchanged"`, plus `iss`, `aud`, `iat`,
`exp`, `jti`. There is deliberately **no user identity** — no email, no user ID,
no role claim. The token says "orb X of project Y", never "acting for person Z".

Exit codes, which are the whole interface for an executable credential source:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | a token was printed | — |
| 2 | bad arguments, or not inside an orb runtime | fix the command |
| 3 | unauthorized: this incarnation's bearer was refused | the orb's compute was replaced; stop, do not loop |
| 4 | not mintable: the orb's lifecycle state forbids identity | expected while the orb is stopping or stopped |
| 5 | rate limited: the per-orb mint floor is in force | wait; do not hammer |
| 6 | unavailable: control plane unreachable or flaky | retry later |
| 7 | internal control-plane error | report it; retrying cannot help |

The CLI already retries 5, 6, and the first-boot 401 inside its own ten-second
budget, so treat whatever it returns as final rather than wrapping it in a loop.

## Rules — read these before your first mint

- **Never mint under a traced shell.** `set -x`, `bash -x`, or any wrapper that
  echoes commands prints a live bearer credential into the transcript.
- **Never write the JWT to a file, a log, or a command line.** Use command
  substitution or an executable credential source. AWS SDKs are the one
  exception (they read a file), and that case has extra rules below.
- **The audience is not authorization.** Any orb of this deployment can request
  any audience. What actually bounds a grant is the relying party matching
  `project_id` / `orb_id` / `host_incarnation`. Never tell the user that
  choosing an audience string protects anything.
- **You cannot create the trust configuration.** The workload identity pool,
  IAM role, or verifier lives in the *cloud* account, not in this orb, and
  needs privileges this orb does not have. If it does not exist yet, tell the
  human exactly what to create and stop. Do not invent trust config, and do not
  fall back to asking for a long-lived key or service-account JSON — that is
  the thing this feature exists to avoid.
- **A stopped or replaced orb stops minting** (exit 3 or 4). That is by design:
  identity follows the orb's live authorization, not a stored key. An
  already-issued token cannot be revoked, so ask for the shortest lifetime that
  works.

## Know your own identity first

The operator has to bind a grant to *this* orb or *this* project, so find out
what to give them. This prints only non-secret claims, never the token:

```sh
PI_ORB_SELF_TOKEN=$(pi-orb id-token --audience urn:pi-orb:self-inspect) python3 - <<'PY'
import base64, json, os
payload = os.environ["PI_ORB_SELF_TOKEN"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
print(json.dumps({k: claims[k] for k in ("iss", "sub", "project_id", "orb_id", "host_incarnation") if k in claims}, indent=2))
PY
```

`iss` is the deployment's public issuer origin; the operator needs it, and its
discovery document is at `<iss>/.well-known/openid-configuration`.

## Google Cloud — the worked example

### 1. Confirm the operator side exists

Federation needs a workload identity pool and an OIDC provider bound to this
deployment's issuer, plus a grant. That is **operator-side work in the GCP
project**, done once, and not something you can do from here. Ask the human for:

- the GCP **project number** `<N>`, the **pool ID**, and the **provider ID**;
- the **audience string** the provider accepts (typically
  `urn:pi-orb:gcp:<gcp project>`);
- the **service account email** to impersonate, or confirmation that direct
  federated access is granted.

If they do not have those, tell them to follow the GCP recipe in the pi-orb
repository — `docs/workload-identity-recipes.md`, whose reviewed idempotent
script is `infra/bootstrap-pi-orb-oidc.sh` — and to bind the grant to this
orb's `project_id` or `orb_id` from the section above. Two things worth passing
on because they are the failures people hit: the provider's attribute mapping
must wrap the numeric `host_incarnation` claim in `string()` or *every* exchange
fails, and a pool that conditions on nothing admits every orb of the deployment.
Then stop and wait; there is nothing to try in the meantime.

### 2. Write the external-account configuration

The file contains **no secret** — it names a program that mints a fresh token on
each refresh. The image ships that program, reviewed, at
`/usr/local/bin/pi-orb-gcp-identity`; do not write your own and never download
one.

```sh
umask 077
cat > "$HOME/.pi-orb-gcp.json" <<'JSON'
{
  "type": "external_account",
  "audience": "//iam.googleapis.com/projects/<N>/locations/global/workloadIdentityPools/<pool>/providers/<provider>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<sa email>:generateAccessToken",
  "credential_source": {
    "executable": {
      "command": "/usr/local/bin/pi-orb-gcp-identity",
      "timeout_millis": 30000
    }
  }
}
JSON
chmod 600 "$HOME/.pi-orb-gcp.json"
```

Drop the `service_account_impersonation_url` line entirely if the grant is
direct federated access rather than impersonation.

### 3. Export three variables, scoped to the federating process

```sh
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.pi-orb-gcp.json"
export PI_ORB_GCP_AUDIENCE='urn:pi-orb:gcp:<gcp project>'
export GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1
```

`GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` is a global "credential files may
execute programs they name" switch. Set it in the environment of the commands
meant to federate — not in `~/.bashrc`, not in a systemd unit for everything.
All three are needed on **every** invocation, including gcloud's, because the
helper runs again on each credential refresh.

### 4. Use it

Client libraries that read Application Default Credentials (Python
`google-cloud-*`, Node `google-auth-library`, Go, Java) need nothing further —
`GOOGLE_APPLICATION_CREDENTIALS` is enough. Prefer them.

For the `gcloud` CLI:

```sh
gcloud auth login --cred-file="$HOME/.pi-orb-gcp.json"
gcloud auth print-access-token >/dev/null && echo "federation works"
```

That login persists in `$HOME`, which is this orb's durable filesystem: it
survives stop/start and compute replacement, so it is a one-time step, not a
per-session one. The three environment variables do **not** persist that way —
re-export them in each new shell.

`gcloud` may not be installed in this image. Check with `command -v gcloud`; if
it is missing, either install it into `$HOME` (it will persist) or use an
ADC-based client library instead, which is usually the faster path.

### 5. When it fails

| Symptom | Cause |
| --- | --- |
| `Executables need to be explicitly allowed` | `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` not set for *this* process |
| helper aborts on `PI_ORB_GCP_AUDIENCE` | the variable is unset in the process that loads the credential |
| STS rejects the audience | the `audience` field or `PI_ORB_GCP_AUDIENCE` does not match the provider — operator-side |
| `The mapped attribute must be of type STRING` | the provider's mapping is missing `string(assertion.host_incarnation)` — operator-side |
| permission denied impersonating the service account | the principalSet binding does not cover this orb — operator-side, give them `project_id`/`orb_id` |
| `pi-orb id-token` exits 3 or 4 | this orb is stopped or its compute was replaced; not a GCP problem |

## AWS

Ask the operator to register this deployment's issuer as an IAM OIDC provider,
create the role, and tell you the **role ARN** and the **audience** they
registered as a client ID (prefer one audience per role). Be honest about the
limit when you ask: for a self-registered OIDC provider AWS can condition a
trust policy only on `aud` and `sub` — pi-orb's `project_id`, `orb_id`,
`host_incarnation`, and `token_use` are not available as condition keys, and a
`StringEquals` on a missing key is false, so a policy naming them is a role
nobody can assume. `sub` is this orb's ID, so an `aud`-only policy grants the
role to *every* orb of the deployment. A project-wide AWS grant is not
expressible; that needs a small relying service that verifies the token itself
and calls `sts:AssumeRole`.

AWS SDKs read the web-identity token from a *file*, so it touches disk. Keep it
0600, short-lived, and removed on exit — never pass the JWT on a command line
(`assume-role-with-web-identity --web-identity-token <jwt>` leaks it into shell
history and `ps`):

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

The SDK re-reads that file on refresh, so a long-running process needs it
rewritten before the JWT expires. A passing `get-caller-identity` proves the
audience matched, never that AWS checked which orb you are.

## Generic OIDC services

Anything that verifies an OIDC ID token can accept this orb. Ask the operator
for the audience the service expects, and confirm it verifies the RS256
signature against the JWKS named by `<iss>/.well-known/openid-configuration`,
plus `iss`, `aud`, `token_use`, `exp`/`iat` with at most 60 s skew, **and** the
`project_id`/`orb_id` the grant is meant to cover. A service checking only `iss`
and `aud` has authorized every orb of the deployment; say so rather than letting
it ship. Then mint per request and keep the token in memory:

```sh
printf 'header = "Authorization: Bearer %s"\n' \
  "$(pi-orb id-token --audience '<audience>')" \
  | curl -sS -K - https://service.example/api
```

The `-K -` form keeps the token out of `argv`, where `ps` and process listings
would show it; `curl -H "Authorization: Bearer <jwt>"` does not.
