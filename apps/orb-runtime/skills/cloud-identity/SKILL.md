---
name: cloud-identity
description: Obtain short-lived cloud credentials (GCP, AWS, generic OIDC) inside this orb with `pi-orb id-token`, pi-orb workload identity — no stored secret, no service-account key, no interactive login. Use when a task needs gcloud, Google Cloud APIs, AWS APIs, or authenticated access to a private service that trusts an OIDC identity, when a cloud call fails with missing, expired, or absent credentials, or when the cloud account has not been connected to this orb yet — the skill prints the setup commands for a human to run.
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
- **You print the trust configuration; the human runs it.** The workload
  identity pool, IAM role, or verifier lives in the *cloud* account and needs
  admin privileges this orb does not have and must never be given: an admin
  credential must not enter an orb. So do not try the admin commands here, and
  never ask for a long-lived key, a service-account JSON, or a pasted admin
  token — that is the thing this feature exists to avoid. Instead hand the human
  a finished, pre-filled block to run on their own machine, as below.
- **A stopped or replaced orb stops minting** (exit 3 or 4). That is by design:
  identity follows the orb's live authorization, not a stored key. An
  already-issued token cannot be revoked, so ask for the shortest lifetime that
  works.

## Know your own identity first

A grant binds to *this* orb or *this* project, so read the values that go into
it. This prints only non-secret claims, never the token:

```sh
PI_ORB_SELF_TOKEN=$(pi-orb id-token --audience urn:pi-orb:self-inspect) python3 - <<'PY'
import base64, json, os
payload = os.environ["PI_ORB_SELF_TOKEN"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
print(json.dumps({k: claims[k] for k in ("iss", "sub", "project_id", "orb_id", "host_incarnation") if k in claims}, indent=2))
PY
```

`iss` is the deployment's public issuer origin — the trust anchor the cloud side
is pointed at; its discovery document is at
`<iss>/.well-known/openid-configuration`.

## Google Cloud — the worked example

You know everything needed except which GCP project to connect. Ask for that,
choose every other name yourself, and hand the human one block to run. Do not
make them read documentation or find a script.

### 1. Ask for one thing

> Which GCP project should this orb reach? I will set it up read-only
> (`roles/viewer`) unless you want something else.

That is the whole question. Do **not** ask for pool, provider, or service
account names, or for a project number — you pick the names, and the block you
print prints the number back. Defaults, which are stable and safe to reuse
across orbs:

| Thing | Value |
| --- | --- |
| pool | `pi-orb-orbs` |
| provider | `pi-orb-oidc` |
| audience | `urn:pi-orb:gcp:<gcp project>` |
| service account | `pi-orb-<first 8 characters of the pi-orb project ID>` |
| role | `roles/viewer` (read-only) unless the human named another |

### 2. Read your own identity

Run the self-inspect snippet above. `iss`, `project_id`, and `orb_id` fill in
the block below; nothing else is needed from anywhere.

### 3. Print the block for the human to run

Substitute **every** `<…>` before showing it — the human must have nothing to
edit, only paste. `<short>` is the first 8 characters of `<pi-orb project id>`.
Say these three things with it:

- Run it **on your own machine**, in a shell where `gcloud` is already
  authenticated as an administrator of that project. Never inside this orb: an
  admin credential must never enter an orb, and this orb only ever holds its own
  identity.
- Re-running is safe. Every step either describes-or-creates or is an idempotent
  binding; nothing is deleted.
- One line at the end is the only thing to paste back.

```sh
# Enable the four APIs federation uses.
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com cloudresourcemanager.googleapis.com --project='<gcp project>'

# A pool to hold pi-orb identities.
gcloud iam workload-identity-pools describe pi-orb-orbs \
  --project='<gcp project>' --location=global >/dev/null 2>&1 || \
gcloud iam workload-identity-pools create pi-orb-orbs \
  --project='<gcp project>' --location=global --display-name='pi-orb orbs' \
  --description='Keyless access from admitted pi-orb orbs'

# The provider: trusts this pi-orb deployment's issuer, only that audience, and
# only tokens minted by pi-orb project <pi-orb project id>.
gcloud iam workload-identity-pools providers describe pi-orb-oidc \
  --project='<gcp project>' --location=global \
  --workload-identity-pool=pi-orb-orbs >/dev/null 2>&1 || \
gcloud iam workload-identity-pools providers create-oidc pi-orb-oidc \
  --project='<gcp project>' --location=global \
  --workload-identity-pool=pi-orb-orbs --display-name='pi-orb orb OIDC' \
  --issuer-uri='<iss>' \
  --allowed-audiences='urn:pi-orb:gcp:<gcp project>' \
  --attribute-mapping='google.subject=assertion.sub,attribute.project_id=assertion.project_id,attribute.orb_id=assertion.orb_id,attribute.host_incarnation=string(assertion.host_incarnation)' \
  --attribute-condition="assertion.token_use == 'exchanged' && assertion.project_id == '<pi-orb project id>'"

# The service account orbs impersonate, and what it is allowed to do.
gcloud iam service-accounts describe 'pi-orb-<short>@<gcp project>.iam.gserviceaccount.com' \
  --project='<gcp project>' >/dev/null 2>&1 || \
gcloud iam service-accounts create 'pi-orb-<short>' --project='<gcp project>' \
  --display-name='pi-orb orbs of project <pi-orb project id>'

gcloud projects add-iam-policy-binding '<gcp project>' \
  --member='serviceAccount:pi-orb-<short>@<gcp project>.iam.gserviceaccount.com' \
  --role='roles/viewer' --condition=None --quiet >/dev/null

# Let orbs of that one pi-orb project impersonate it — and nothing else.
number=$(gcloud projects describe '<gcp project>' --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding \
  'pi-orb-<short>@<gcp project>.iam.gserviceaccount.com' \
  --project='<gcp project>' --role='roles/iam.workloadIdentityUser' --quiet \
  --member="principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/pi-orb-orbs/attribute.project_id/<pi-orb project id>" \
  >/dev/null

echo "paste this line back: //iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/pi-orb-orbs/providers/pi-orb-oidc"
```

Line by line: enable the APIs; create the pool; create the provider bound to
this deployment's issuer, with the attribute mapping IAM binds to and the
condition that admits only this pi-orb project's orbs; create the service
account and give it the role; let this project's orbs impersonate it; print the
one string you still need. The `string(assertion.host_incarnation)` cast is
load-bearing — GCP evaluates the whole mapping on every exchange, so an
unconverted number fails *all* of them.

Wait for the human to run it. There is nothing to try in the meantime.

(The pi-orb repository's `infra/bootstrap-pi-orb-oidc.sh` is the reviewed long
form of this block, with scope reconciliation and a smoke test. The human does
not need it.)

### 4. Write the external-account configuration

Once the human says done, finish without asking anything else: you chose every
name, and the line they pasted back is the `audience` below.

The file contains **no secret** — it names a program that mints a fresh token on
each refresh. The image ships that program, reviewed, at
`/usr/local/bin/pi-orb-gcp-identity`; do not write your own and never download
one.

```sh
umask 077
cat > "$HOME/.pi-orb-gcp.json" <<'JSON'
{
  "type": "external_account",
  "audience": "<the line they pasted back>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/pi-orb-<short>@<gcp project>.iam.gserviceaccount.com:generateAccessToken",
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

### 5. Export three variables, scoped to the federating process

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

### 6. Prove it works

```sh
gcloud auth login --cred-file="$HOME/.pi-orb-gcp.json"
gcloud projects describe '<gcp project>'
```

That is the whole confirmation: a project description means the exchange, the
impersonation, and the role all worked. Report it and carry on with the task.

The login persists in `$HOME`, this orb's durable filesystem: it survives
stop/start and compute replacement, so it is a one-time step, not a per-session
one. The three environment variables do **not** persist that way — re-export
them in each new shell, including for gcloud, because the helper runs again on
every refresh.

Client libraries that read Application Default Credentials (Python
`google-cloud-*`, Node `google-auth-library`, Go, Java) need no login at all —
`GOOGLE_APPLICATION_CREDENTIALS` is enough.

The image ships `gcloud`. In the unlikely case `command -v gcloud` finds
nothing, skip straight to an ADC client library; the credential file is the same.

### 7. Variants

- **A different, or a second, GCP project.** Same block, new project ID: each
  GCP project trusts pi-orb independently, and the two grants do not interact.
  Write a second credential file.
- **Several pi-orb projects into one GCP project.** Broaden the condition to a
  set — `assertion.token_use == 'exchanged' && assertion.project_id in ['<a>',
  '<b>']` — but keep one service account and one `principalSet` binding per
  pi-orb project, so the projects cannot use each other's role.
- **One orb only.** Condition on `assertion.orb_id == '<orb id>'` and bind
  `…/attribute.orb_id/<orb id>` instead. The grant dies with the orb.
- **Changing what the orb may do.** Re-run only the
  `projects add-iam-policy-binding` line with the new role. Adding is additive:
  say so, and pair it with `remove-iam-policy-binding` for the old role if the
  point was to narrow.

### 8. When it fails

| Symptom | Cause |
| --- | --- |
| `Executables need to be explicitly allowed` | `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=1` not set for *this* process |
| helper aborts on `PI_ORB_GCP_AUDIENCE` | the variable is unset in the process that loads the credential |
| STS rejects the audience | the `audience` field or `PI_ORB_GCP_AUDIENCE` does not match `--allowed-audiences` |
| `The mapped attribute must be of type STRING` | the provider's mapping lost `string(assertion.host_incarnation)`; have the human re-run the provider command against an existing provider with `update-oidc` in place of `create-oidc` |
| permission denied impersonating the service account | the `principalSet` binding does not cover this orb — re-run that line with the right `project_id`/`orb_id` |
| `pi-orb id-token` exits 3 or 4 | this orb is stopped or its compute was replaced; not a GCP problem |

## AWS

Same shape: ask for the **AWS account ID**, default the role to read-only, and
print one pre-filled block for the human to run **on your own machine** with an
admin identity — never in this orb. Fill `<iss host>` (the `iss` from step 2
without `https://`) and `<orb id>` from your own identity.

The limit to state while you ask: for a self-registered OIDC provider AWS can
condition a trust policy only on `aud` and `sub`. pi-orb's `project_id`,
`orb_id`, `host_incarnation`, and `token_use` are not condition keys, and
`StringEquals` on a missing key is false, so a policy naming them is a role
nobody can assume. `sub` is this orb's ID, so the grant below is **per orb**,
and an `aud`-only policy would grant the role to every orb of the deployment. A
pi-orb-project-wide AWS grant is not expressible; that needs a small relying
service that verifies the token itself and calls `sts:AssumeRole`.

```sh
# Trust this pi-orb issuer, for this audience only. Once per account.
aws iam create-open-id-connect-provider --url 'https://<iss host>' \
  --client-id-list 'urn:pi-orb:aws:<account>:pi-orb-<orb id>'

# A role only this orb can assume.
cat > /tmp/pi-orb-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account>:oidc-provider/<iss host>" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": { "StringEquals": {
      "<iss host>:aud": "urn:pi-orb:aws:<account>:pi-orb-<orb id>",
      "<iss host>:sub": "<orb id>"
    } }
  }]
}
JSON
aws iam create-role --role-name 'pi-orb-<orb id>' \
  --assume-role-policy-document file:///tmp/pi-orb-trust.json \
  --max-session-duration 3600

aws iam attach-role-policy --role-name 'pi-orb-<orb id>' \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```

Re-running `create-open-id-connect-provider` for an existing issuer errors
harmlessly; add another audience with `add-client-id-to-open-id-connect-provider`
instead. If the CLI demands `--thumbprint-list`, the issuer is behind a public
CA and AWS ignores the value.

AWS SDKs read the web-identity token from a *file*, so it touches disk. Keep it
0600, short-lived, and removed on exit — never pass the JWT on a command line
(`assume-role-with-web-identity --web-identity-token <jwt>` leaks it into shell
history and `ps`):

```sh
umask 077
token_file=$(mktemp "${TMPDIR:-/tmp}/pi-orb-web-identity.XXXXXX")
trap 'rm -f "$token_file"' EXIT INT TERM HUP
pi-orb id-token --audience 'urn:pi-orb:aws:<account>:pi-orb-<orb id>' > "$token_file"
export AWS_ROLE_ARN='arn:aws:iam::<account>:role/pi-orb-<orb id>'
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
