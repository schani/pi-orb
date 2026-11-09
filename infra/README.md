# pi-orb cloud deployment

Operator procedure. Design decisions and release-safety rules: `docs/deployment.md`.

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
One Cloud Run service, `pi-orb-issuer`. App, API and broker use the exact issuer
origin; files use its `files` traffic-tag origin. `app_url` and `issuer_url` are
identical; neither is Cloud Run's hashed `.uri`.

## Deploy

Apply the foundation first (`infra/foundation/README.md`); the release refuses an
unapplied or mismatched foundation.

**GitHub Actions (normal path):** Deploy → Run workflow → `main`, leaving
`validate_release` empty. The `qualify` job waits for exact-SHA CI, E2E and
Durable qualification; refusal reasons appear in the job summary. The release
job runs `./infra/release.sh --yes`. Its summary and the single `release.json`
artifact report the outcome and any retained fixtures.

Inputs:

- `validate_release`: a recorded release ID or `latest` for validation-only recovery.
- `migration_timeout_30m`: allow one release's migration job 1800 s instead of 600 s.
- `first_consolidation`: one-time retirement of the three pre-consolidation
  services; leave it `false` on a consolidated deployment.

**Local:**

    ./infra/release.sh                     # shows the plan, type `deploy` to apply
    ./infra/release.sh --yes               # non-interactive (CI)
    ./infra/release.sh --validate RELEASE_ID|latest
    ./infra/release.sh --migration-timeout-30m

It requires a clean selected commit on local branch `main` and runs typecheck,
lint, unit checks and E2E itself. `--validate` cannot combine with the migration
override.

Both release and validation require `PI_ORB_USER_ID` (repository variable in
GitHub; production `53da7ad4-6c53-4223-868e-0641bb4bcdd9`). It owns the
disposable smoke fixtures and selects the credential owner for migration 024.
For a database where migration 023 has existing ownership data, a local release
may also supply the all-or-none tuple `PI_ORB_ORIGINAL_USER_ID`,
`PI_ORB_ORIGINAL_IDENTITY_ISSUER`, `PI_ORB_ORIGINAL_IDENTITY_SUBJECT`; its UUID
must match `PI_ORB_USER_ID`. GitHub needs no `PI_ORB_ORIGINAL_*`.

The release preserves the existing database password; plans must not change it.

## Stages

1. `checks`: tools, Docker, auth, foundation, scoped authority, machine API access, read-only plan; GitHub reuses verified qualification, local runs checks/E2E.
2. `build`: build and boot-validate native images; push the digest-pinned, source-labelled control-plane image.
3. `plan`: clamp the generation; save the exact plan; reject database/credential changes.
4. `schema`: one-task, no-retry Cloud Run migration job from the accepted image.
5. `apply`, then `repair`: apply the saved plan; `deploy.sh` verifies files routing and deletes non-serving revisions.
6. `retire`, `activate`: Monitoring proof of old-process retirement and no pending compute operations; publish activation.
7. `lifecycle`, `identity`: `smoke.sh` and `smoke-workload-identity.sh`; delete successful fixtures and verify 404.

`build-push.sh`, `deploy.sh`, `smoke.sh` and `smoke-workload-identity.sh` are
implementation stages for diagnostics, not separate operator steps. Rebuild a
native image independently with `infra/native-vm/README.md`.

## Lock, records and failures

- Lock: `gs://pi-orb-tfstate-<project>/static-plane/release.lock` (release, commit,
  workflow, host, PID, start). A lock retained after an uncertain retirement,
  migration or apply is deliberate: inspect the recorded stage and the exact Cloud
  Run job/execution and Compute operations first. Remove it only with its
  object-generation guard. Never infer safety from an expired shell or deleted revision.
- Records: `static-plane/releases/RELEASE_ID.json` plus `latest.json`, and the
  printed local result directory. Activation: `static-plane/releases/active.json`.
- Schema may have committed even if apply never ran.
- Failed smoke fixtures stay for diagnosis; their IDs and cost warning are printed.
  Preserve evidence, then delete only those fixtures.
- Never upload or commit the workspace, state, saved plans or raw diagnostic
  directories. Native build evidence stays under `.context/native-image-release/`.

## Authentication provisioning

Register a Google **web application** OAuth client manually with both redirect URIs:
`<app_url>/auth/callback` and `<hosting_url>/auth/callback`. Configure the
Workspace consent screen for `heyglide.com`. Update GitHub/MCP callback
registrations and provider allowlists when the app origin changes.

Production Deploy pins the public `TF_VAR_google_client_id`. Before the first
release, stage `pi-orb-google-client-secret` and `pi-orb-cookie-secret` in Secret
Manager, version **1** each. Generate the cookie key once (at least 32 random
bytes) and keep it across releases. IaC reads only container metadata, grants the
control-plane identity access and pins version 1; it never reads the payloads.

The release verifies enabled versions and derives `TF_VAR_machine_subject` from an
IAM read of `pi-orb-debug@<project>.iam.gserviceaccount.com` (exact email, enabled,
numeric `uniqueId`; `docs/auth.md`). Request-log exclusions for Google and MCP
callbacks precede the app revision.

GitHub App: the client ID is the tofu variable `github_client_id`; tofu creates the
Secret Manager parent `pi-orb-github-client-secret`, and after registering the App
an operator adds the version:

    printf '%s' "$CLIENT_SECRET" | \
      gcloud secrets versions add pi-orb-github-client-secret --data-file=-

## Optional HTTP preview ingress

`TF_VAR_preview_origin` empty disables registration. Production Deploy sets
`https://piorb.live`. Set it only to the exact HTTPS origin of an owned domain on a
different registrable site from app/files (no trailing slash). `run.tf` injects
`PI_ORB_PREVIEW_ORIGIN`; `preview.tf` builds the ingress and log exclusion in the
foundation-owned `pi-orb-preview` zone (design and log-routing caveats:
`docs/http-exposure.md`).

An alternative TLS proxy must route wildcard preview hosts to the issuer backend
preserving Host, path/query and WebSocket Upgrade, without logging:

```nginx
map $http_upgrade $preview_connection {
    default upgrade;
    ''      '';
}
server {
    listen 443 ssl;
    server_name *.PREVIEW_BASE_HOST;
    ssl_certificate     /operator/wildcard/fullchain.pem;
    ssl_certificate_key /operator/wildcard/key.pem;
    access_log off;
    error_log /dev/null;
    location / {
        proxy_pass https://EXACT_EXISTING_ISSUER_HOST;
        proxy_ssl_server_name on;
        proxy_ssl_name EXACT_EXISTING_ISSUER_HOST;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $preview_connection;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Validate Host handling over the real deployed hop, not just nginx syntax.

## Tooling access

Project orbs get keyless GCP access from `.agents/setup` (client install) and
`.agents/resume` (registers the federated credential every start). Verify before use:

    gcloud auth list
    gcloud config get-value project

    ./infra/api.sh /api/v1/projects
    ./infra/api.sh /api/v1/orbs/<id>/start '{}'

`api.sh` impersonates `pi-orb-debug@…` and sends a Google ID token (kept out of
argv) with the app-origin audience. The debug account and its Token Creator
binding: `infra/foundation/README.md`.

History desync diagnosis and guarded offline recovery: `docs/history.md`.

## Workload identity

The issuer URL is the trust anchor:

    tofu -chdir=infra output -raw issuer_url
    curl -s "$(tofu -chdir=infra output -raw issuer_url)/.well-known/openid-configuration"

If the `.urls` postcondition fails, stop: changing the origin is a trust migration.

Federating a cloud account with this issuer is a separate one-time administrator step:

    PI_ORB_TRUSTED_PROJECT_ID=<pi-orb project UUID> \
      ./infra/bootstrap-pi-orb-oidc.sh --dry-run
    PI_ORB_TRUSTED_PROJECT_ID=<pi-orb project UUID> \
      ./infra/bootstrap-pi-orb-oidc.sh

It prints the `PI_ORB_SMOKE_WIF_*` values for the federation smoke. It refuses to
run without an identity scope unless `ALLOW_ANY_ORB=1` (the audience is not an
authorization boundary) and refuses to repoint an existing provider at another
issuer. Re-running with a narrower scope revokes the broader bindings it owns;
`--dry-run` lists them under `revoking:` — review that line.

`smoke-workload-identity.sh` creates two disposable orbs (the second probes a
stopped orb's bearer, read from GCE metadata, from inside the VPC), mints through
`pi-orb id-token` over `gcloud compute ssh --tunnel-through-iap` (polling SSH under
its own deadline), and verifies against live discovery/JWKS. Stopped-orb
`403 not_mintable` and unknown-bearer `401` checks always run. With
`PI_ORB_SMOKE_WIF_AUDIENCE`, `PI_ORB_SMOKE_WIF_STS_AUDIENCE` and
`PI_ORB_SMOKE_WIF_TEST_SA` it also exchanges through STS, impersonates the test
account, calls a read-only API and proves a wrong-audience token fails; unset, those
legs skip loudly. Standalone runs create a disposable project unless
`PI_ORB_SMOKE_PROJECT_ID` names an existing one; the release uses the admitted
repository project. Tokens never print: pipes and mode-0600 files in a mode-0700
directory. Relying-party recipes: `apps/orb-runtime/skills/cloud-identity/SKILL.md`.

## Gotchas

- An apply without `deploy_generation` runs at generation 0 and never repairs
  hosts stamped by earlier deploys. Draining revisions keep reconciling after
  deletion; only retirement proof stops them (`docs/deployment.md`).
- Workspace session policy expires gcloud user credentials roughly daily:
  `gcloud auth login` when everything returns empty or errors.
- Orb VM boot diagnostics: `gcloud compute instances get-guest-attributes <vm>
  --query-path=pi-orb/startup`; serial console as fallback.
- Cloud SQL has deletion protection; `tofu destroy` refuses it by design.
- The release lock outlives a trap-bypassing process death; verify its owner and
  cloud operations before removing it.
