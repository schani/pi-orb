# pi-orb cloud deployment

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
One Cloud Run application: `pi-orb-issuer`, using the control-plane service
account, always-allocated CPU, one minimum/maximum instance, 3600-second requests
and private VPC egress. App/API/broker use the **exact existing issuer origin**;
files use its separate `files` traffic-tag origin. `app_url` and `issuer_url` are
identical; neither substitutes Cloud Run's hashed `.uri`. Compute SSH retains IAP.
Google browser login and machine token verification happen in the application.

## Deploy workflow

First apply the separately authorized foundation (`infra/foundation/README.md`). The release refuses an unapplied or mismatched foundation. **Status (2026-09-16):** GitHub keyless authentication and the manual workflow are operational. [Release 35104816962](https://github.com/schani/pi-orb/actions/runs/35104816962) deployed project instructions from `7d53024` at generation `1789569278`; all gates passed on the first attempt and the release was validated at 14:52:20 UTC. Smoke fixtures were deleted and the release lock is absent. Exact image identities, the durable record and earlier release/recovery evidence are in `docs/deployment.md`. The user deferred database password rotation; release plans must preserve the existing credential.

In GitHub Actions, select **Deploy → Run workflow → main**, leaving
`validate_release` empty for a new deployment. Supply a recorded release ID or
`latest` only for explicit validation-only recovery. The workflow pins tools,
rejects a dispatched commit that is no longer main, and runs `infra/release.sh`
under non-cancelled concurrency. Its summary and single allowlisted JSON artifact
report the actual outcome and retained fixtures; raw plans/state/log bundles are
never uploaded. The job timeout is 240 minutes. Normal releases retain HTTP availability; the first
identity cutover requires the maintenance procedure below.

The supported manual deployment is one command from the repository root:

    ./infra/release.sh

It requires a clean `main` checkout exactly matching freshly fetched
`origin/main`, shows the exact OpenTofu plan, and requires typing `deploy` before
applying. `./infra/release.sh --yes` is the non-interactive form shared with CI.

`./infra/release.sh --validate RELEASE_ID` explicitly validates the recorded
application without rebuilding, migrating or applying infrastructure. `latest`
selects the latest recorded attempt. It verifies the serving image/revision
identities and lifecycle generations, preserves the original failure record,
and creates a separate validation result naming both deployed and runner commits.
Both deployment and validation require repository/environment variable
`PI_ORB_USER_ID`. It selects disposable smoke ownership and, for pending migration
024, the exact existing `users` row whose verified identity owns legacy credential
pointers; an unknown UUID fails the migration. The production value is
`53da7ad4-6c53-4223-868e-0641bb4bcdd9`. GitHub needs no `PI_ORB_ORIGINAL_*`
variables. For a database where migration 023 still has existing ownership data,
a local release may supply the all-or-none bootstrap tuple
`PI_ORB_ORIGINAL_USER_ID`, `PI_ORB_ORIGINAL_IDENTITY_ISSUER`, and
`PI_ORB_ORIGINAL_IDENTITY_SUBJECT`; its UUID must match `PI_ORB_USER_ID`. Validation
runs no migration but still creates and cleans up the existing disposable smoke
fixtures.
Validation checks routing and prunes old revisions before retirement, including
failures after apply but before the initial serving snapshot. The accepted image
and generation must match the application. Do not validate merely to obtain green
from an unexplained failure.

New autonomous loops wait behind a startup barrier while HTTP remains available;
only independently observed old-process retirement permits activation. This
barrier does **not** stop HTTP identity writers.

The script owns the complete transaction. Native image versions use
`v-<short-commit>` so every Git hash forms a valid GCE resource-name segment.

The stages are:

1. verify tools, Docker, auth, foundation, machine API access and a non-mutating application plan; install locked dependencies, run typecheck/lint/unit checks, build the local Docker E2E runtime image and run E2E before cloud image builds;
2. build/boot-validate native images and push the digest-pinned, source-labelled control-plane image;
3. clamp generation above serving and published authority, create the exact saved plan, and reject database/credential changes;
4. run migrations using that image in a one-task Cloud Run job, with retries disabled, before any new service consumes schema;
5. apply and delete non-serving application revision metadata;
6. require explicit zero active/idle counts for old application revisions, including deleted-but-live revisions discovered through Monitoring, and no unfinished pi-orb compute mutations; publish activation only after rechecking serving identity;
7. run lifecycle and identity smokes, mandatory peer-to-peer preview health and actual GCP federation through this repository's admitted project; verify successful fixture deletion and unchanged serving identity.

Generated variables and the binary plan live under `umask 077` in a mode-0700
temporary directory and are removed on exit; they must never be retained because
OpenTofu plans embed state secrets. A generation-matched object at
`gs://pi-orb-tfstate-<project>/static-plane/release.lock` serializes the complete
transaction across workstations and runners; a same-workstation lock fails even
earlier. The object identifies the release, commit, workflow, host, PID and start.
An uncertain migration execution deliberately retains this lock: inspect the
recorded Cloud Run job before unlocking. Never infer safety from an expired shell
or deleted revision. GitHub concurrency is additional protection, not a substitute.

Token-free records live in `static-plane/releases/RELEASE_ID.json`, with a
`latest.json` pointer, and in the printed local result directory. They distinguish
failed-before-apply, applied-but-unvalidated and validated; an interrupted apply
is conservatively unvalidated. Schema changes may have committed even before an
application apply—there is no automatic migration rollback. Failed smoke fixtures
remain for diagnosis, with ownership/cleanup outcomes in the result. Native-build
cleanup records token-free target intent before inspection and exact operation
identity before polling. It reports `submitted`, `failed`, or `uncertain`; an
uncertain submission is not retried automatically. Authentication and REST
submission each have a 30-second bound, predecessor waiting has a 60-second
bound, and exact-operation polling has a 12-minute bound. Cleanup does not hold
the global pre-apply lock indefinitely. Local credential scratch is removed on
handled exits. Never upload the workspace, state, saved plans or raw diagnostic
directories.

`build-push.sh`, `deploy.sh`, `smoke.sh`, and `smoke-workload-identity.sh` remain
implementation stages for diagnostics; they are not separate operator steps. The native build boots a fresh VM and requires runtime readiness, correct ownership/storage, and disabled Docker services before accepting the image. Release validates its manifest against the exact source commit and project. Rebuild an image independently using `infra/native-vm/README.md`; the accepted manifest and logs remain under `.context/native-image-release/`.

## Google authentication provisioning

Register a Google **web application** OAuth client manually. Register both exact
redirect URIs: `<app_url>/auth/callback` and `<hosting_url>/auth/callback`.
Configure the Workspace consent screen for `heyglide.com`. Update GitHub/MCP
callback registrations and provider allowlists to the new app origin; reconnect
integrations where necessary. No old-URL aliases are deployed.

Supply `TF_VAR_google_client_id`, `TF_VAR_google_client_secret` and
`TF_VAR_cookie_secret` to OpenTofu. Generate the cookie key once with at least 32
random bytes (for example `openssl rand -base64 32`); retain it across restarts
and releases. Validation requires at least 32 characters. GitHub **Deploy** uses
repository variable `PI_ORB_GOOGLE_CLIENT_ID` and secrets
`PI_ORB_GOOGLE_CLIENT_SECRET`, `PI_ORB_COOKIE_SECRET`. IaC writes secret values to
Secret Manager, pins versions into the revision, and grants the control-plane
identity access. Terraform state and plans contain these secrets: never commit
or upload them. Provision these inputs before running any plan. Replacing the
cookie key invalidates sessions only after all old-key processes retire.

The app sets `PI_ORB_AUTH_MODE=google`. An administrator must read the debug
account's immutable ID with `gcloud iam service-accounts describe
pi-orb-debug@<project>.iam.gserviceaccount.com --format='value(uniqueId)'` and
supply `TF_VAR_machine_subject` (GitHub variable `PI_ORB_MACHINE_SUBJECT`). Verify
that it belongs to the existing debug account; do not use its email or a user ID.
This avoids granting recurring deployment authority additional IAM read access. Machine token audience is the exact app origin.
The debug account and scoped impersonation binding remain external prerequisites.
Request-log exclusions for `/auth/callback` and the MCP callback precede the app
revision, so authorization codes are not retained in Cloud Run request logs.

## First consolidation: controlled maintenance

**Not cloud-validated.** Rehearse migration/apply failure and independent recovery
in an isolated deployment before production authorization. Normal releases reject
the old deployment contract; the explicit `--cutover MANIFEST` path is required.
It runs only under GitHub's independent deployment identity, never an affected orb.

1. Qualify the exact main commit and images; register callbacks and secrets.
   Independently verify every existing identity mapping and preserve user UUIDs.
   Set GitHub secret `PI_ORB_GOOGLE_IDENTITY_MAPPINGS` to a nonempty JSON array of
   `{userId,oldIssuer,oldSubject,googleSubject}`. The migration alone receives it;
   checks/E2E do not. The SQL guard, not email matching, admits those mappings.
2. Create a database recovery point and test an independent restoration identity.
   Inventory orbs, workspace disks and pending wake intents; stop/drain the fleet.
   Do not resume it until owned smoke acceptance. Broker-origin changes require
   workspace-preserving host replacement, not merely restarting old compute.
3. Under the independent identity, initialize a private evidence record, then
   capture **before deletion** every old service revision and pending mutation:

       python3 -m infra.release_state init /private/maintenance-record.json maintenance-<id> <commit> <project> <region> <zone> ''
       python3 -m infra.release_cutover inventory /private/maintenance-record.json /private/maintenance.json

   Keep concurrent release/admin writers excluded throughout maintenance. Block
   old browser/ops invocation, including revision/tag URLs; delete the three old
   services (`pi-orb`, `pi-orb-ops`, `pi-orb-runtime-api`) to prevent reactivation.
   Never delete `pi-orb-issuer`. Drain admitted HTTP work. Deletion is **not** proof.

       python3 -m infra.release_cutover observe /private/maintenance-record.json /private/maintenance.json

   Observation first verifies that the old services are absent, then resets the
   evidence boundary and discards pre-fence zeroes. It requires explicit post-fence
   zero active **and** idle container samples for every inventoried/discovered old revision, plus completed compute
   mutations. Missing samples, API errors and timeouts fail closed. Preserve the
   evidence and diagnose; do not substitute elapsed time or an empty revision list.
4. Review the manifest. Fill `recoveryPoint` and `restorationIdentity`; set
   `fleetStopped` and `wakeIntentsReviewed` only after verifying them. Submit its
   JSON in Deploy's `cutover_manifest` input, leaving `validate_release` empty.
   Before migration the gate checks project/region/commit, confirms every old
   service is absent, and rechecks Monitoring for contradictory positive samples.
   It durably stores the manifest under
   `static-plane/releases/<releaseId>-maintenance.json`. Manifest declarations
   are operator attestations, not automatic database-backup/fleet verification.
5. Migrate, apply the surviving service, retire its former issuer revision and
   activate only after retirement proof. The activation generation advances above
   published authority. Update the foundation separately to remove the issuer-only
   account and browser-IAP administration **after** the surviving service uses the
   control-plane account. Review that foundation plan: federation trust and Compute
   SSH IAP must remain unchanged.
6. Run owned smoke orbs and actual token exchange. Resume the inventoried fleet
   only after acceptance. Remove the one-shot mapping secret when migration is
   confirmed. Failures require explicit independent recovery and a forward
   generation; reverting an image does not undo identity migration. The release
   never automatically restarts old HTTP writers or restores a database.

## Tooling access

Project orbs configure keyless GCP authentication through `.agents/setup` and
`.agents/resume`. The committed `.pi-orb/gcp-external-account.json` contains no
secret: its reviewed executable source, `/usr/local/bin/pi-orb-gcp-identity`,
mints a short-lived pi-orb OIDC token and exchanges it for the existing
`pi-orb-amp-deployer` service account. The service account keeps its historical
name, but the active repository boot path is pi-orb's `pi-orb-orbs` pool and
`pi-orb-oidc` provider. Admission is restricted to immutable pi-orb project ID
`eacd1d25-2825-4c3a-a26b-3923baa86801`; there is no stored service-account key
or recurring browser login.

Setup installs the client without identity. Resume registers the credential on
every start and writes its required variables through the hook environment
file. Verify the active identity and project before using the tooling:

    gcloud auth list
    gcloud config get-value project

    ./infra/api.sh /api/v1/projects
    ./infra/api.sh /api/v1/orbs/<id>/start '{}'

The API helper impersonates `pi-orb-debug@...` against the app origin — no IAP
is involved. That service account and its service-account-level
`roles/iam.serviceAccountTokenCreator` binding for `pi-orb-amp-deployer` are an
external bootstrap prerequisite retained by `infra/bootstrap-amp-oidc.sh`; the
foundation root does not create or manage either one. Verify the binding after
foundation adoption and before the first scoped release.

The federation pool/provider and deployer permissions are a separately
bootstrapped trust boundary, intentionally outside the recurring OpenTofu root.
The older Amp trust path and `infra/bootstrap-amp-oidc.sh` remain independently
scoped adoption records, but repository hooks no longer configure Amp
credentials. The deployer has functional roles for the root's static-plane
resources rather than Owner or Editor and object access only on the static-plane
state bucket. Its externally bootstrapped token creation grant is limited to the
debug service account.

The application root consumes foundation outputs. The foundation owns stable IAM and the trust policies; its adoption removes the old deployer's broader grants through a reviewed plan. That restriction becomes effective only after the foundation adoption and permission changes have been applied.

## Workload identity (docs/workload-identity.md)

The `pi-orb-issuer` service publishes the OIDC documents relying parties verify
minted tokens against. Its URL is the deployment's trust anchor:

    tofu -chdir=infra output -raw issuer_url
    curl -s "$(tofu -chdir=infra output -raw issuer_url)/.well-known/openid-configuration"

OpenTofu computes the existing deterministic origin and uses it for issuer, app
and broker configuration. The service postcondition checks that origin against
Cloud Run's assigned `.urls`. If it fails, stop: changing it is a trust migration,
not a harmless URL substitution. This consolidation changes no federation trust.

Federating a cloud account with this issuer is a **separate, one-time
administrator step**, deliberately outside the recurring plan (same rationale as
`bootstrap-amp-oidc.sh`):

    PI_ORB_TRUSTED_PROJECT_ID=<pi-orb project UUID> \
      ./infra/bootstrap-pi-orb-oidc.sh --dry-run
    PI_ORB_TRUSTED_PROJECT_ID=<pi-orb project UUID> \
      ./infra/bootstrap-pi-orb-oidc.sh

It is idempotent, deletes no resource, and prints the `PI_ORB_SMOKE_WIF_*` values
the federation smoke needs. It refuses to run without an identity scope: the
audience is not an authorization boundary, since any orb of this deployment can
request any audience. It also refuses to repoint an existing provider at a
different issuer — that is a trust migration, not an edit.

Re-running it with a *narrower* scope actually narrows. `add-iam-policy-binding`
is additive, so the script reconciles the two bindings it owns — the pool's
`roles/iam.workloadIdentityUser` admissions on its test account, and that
account's project role — revoking a previous, broader grant (including an
`ALLOW_ANY_ORB=1` wildcard) instead of leaving it standing behind a narrow
`admitted:` line. Nothing else in the project is read or touched, and `--dry-run`
lists every planned revocation under `revoking:`. Review that line: it is the
only place a surviving over-broad grant becomes visible.

`release.sh` then runs `smoke-workload-identity.sh` after `smoke.sh`. It always
creates two disposable orbs (the second exists so a *stopped* orb's refusal can
be probed from inside the VPC), mints through `pi-orb id-token` over
`gcloud compute ssh`, and verifies the token against the live issuer's discovery
and JWKS. With `PI_ORB_SMOKE_WIF_AUDIENCE`, `PI_ORB_SMOKE_WIF_STS_AUDIENCE`, and
`PI_ORB_SMOKE_WIF_TEST_SA` set it additionally exchanges through STS, impersonates
the read-only test account, calls a real API, and proves a wrong-audience token
dies at STS; unset, those legs skip with a loud notice. On success, both orbs
and the disposable project are deleted. On failure, cloud fixtures remain for
inspection; their IDs and a compute/storage cost warning are printed. Preserve
evidence, then explicitly delete only those fixtures. The exit trap removes local
credential scratch for either verdict. No token is ever printed: they move
through pipes and mode-0600 files in a mode-0700 directory.

Relying-party configuration — GCP external-account files, AWS role trust
policies, generic OIDC verification rules — is
`docs/workload-identity-recipes.md`. The reviewed in-orb credential helper is
`scripts/pi-orb-gcp-identity`.

## Gotchas (each learned the hard way)

- During a revision rollover the draining instance's reconciler keeps running
  with the previous host specification for 12+ minutes — not ~2 — and used to
  fight the new revision over orb VMs (see
  docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md). Two
  defenses now: an apply carrying a larger `deploy_generation` fences host
  replacement forward-only, and `deploy.sh` deletes drained revisions of the application
  service. Neither is a complete lifecycle-authority fence: on 2026-08-11 a
  deleted revision continued reconciling for 7m42s, and although it could not
  repair backward, it could still start the host and fail durable orb state
  (`docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`).
  Revision deletion is cleanup, not proof that old machinery has stopped.
  Forgetting the var is safe but degrading: that revision deploys at generation 0 and never
  repairs hosts stamped by earlier deploys — hosts keep booting the old script
  until the next apply that does pass a generation.
- Workspace session policy expires gcloud user credentials roughly daily:
  `gcloud auth login` interactively when everything returns empty/errors.
- Orb VM boot diagnostics: `gcloud compute instances get-guest-attributes
  <vm> --query-path=pi-orb/startup`; serial console as fallback.
- Cloud SQL has deletion protection; `tofu destroy` will refuse it by design.
