# pi-orb cloud deployment

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
Services: `pi-orb` (browser, IAP: @heyglide.com), `pi-orb-runtime-api`
(internal broker), `pi-orb-ops` (tooling; invoker-IAM: pi-orb-debug SA),
`pi-orb-issuer` (public OIDC discovery + JWKS, unauthenticated by design; its own
service account, which can read no signing key and no brokered credential — but
does share the one read/write database credential, `docs/deployment.md`).

## Deploy workflow

First apply the separately authorized foundation (`infra/foundation/README.md`). The release refuses an unapplied or mismatched foundation. **Status (2026-09-09):** GitHub keyless authentication is live-verified. The manual workflow is operational. Normal build/migration/apply completed in run `34407362332`; its IAP-tooling failure is preserved. Corrected validation-only recovery `34411745647` passed all remaining gates at 23:10:45 UTC, with verified fixture cleanup and no remaining release lock. Application source `32d82e5` serves at generation `1788991246`; workflow/recovery fixes are in `95118b4`. No rebuild, migration or apply was repeated to obtain green. The user deferred database password rotation; release plans must preserve the existing credential.

In GitHub Actions, select **Deploy → Run workflow → main**, leaving
`validate_release` empty for a new deployment. Supply a recorded release ID or
`latest` only for explicit validation-only recovery. The workflow pins tools,
rejects a dispatched commit that is no longer main, and runs `infra/release.sh`
under non-cancelled concurrency. Its summary and single allowlisted JSON artifact
report the actual outcome and retained fixtures; raw plans/state/log bundles are
never uploaded. The job timeout is 240 minutes; no browser pause is introduced.

The supported manual deployment is one command from the repository root:

    ./infra/release.sh

It requires a clean `main` checkout exactly matching freshly fetched
`origin/main`, shows the exact OpenTofu plan, and requires typing `deploy` before
applying. `./infra/release.sh --yes` is the non-interactive form shared with CI.

`./infra/release.sh --validate RELEASE_ID` explicitly validates the recorded
application without rebuilding, migrating or applying infrastructure. `latest`
selects the latest recorded attempt. It verifies all four serving image/revision
identities and lifecycle generations, preserves the original failure record,
and creates a separate validation result naming both deployed and runner commits.
It completes IAP reconciliation and old-revision pruning in a separate `repair`
phase before retirement, including failures after apply but before the initial
serving snapshot. The original accepted image/generation must match all four roles.
The SDK beta component is required; a read-only IAP policy request checks it before
any build or mutation.
Do not use it merely to obtain green from an unexplained failure.

The unsafe `--quiesce` path is removed. No normal release pauses the browser.
New autonomous loops wait behind a startup barrier while HTTP remains available;
only independently observed old-process retirement permits activation.

The script owns the complete transaction. Native image versions use
`v-<short-commit>` so every Git hash forms a valid GCE resource-name segment.

The stages are:

1. verify tools, Docker, auth, foundation, ops access and a non-mutating application plan; install locked dependencies, run typecheck/lint/unit checks, build the local Docker E2E runtime image and run E2E before cloud image builds;
2. build/boot-validate native images and push the digest-pinned, source-labelled control-plane image;
3. clamp generation above serving and published authority, create the exact saved plan, and reject database/credential changes;
4. run migrations using that image in a one-task Cloud Run job, with retries disabled, before any new service consumes schema;
5. apply, preserve native IAP, reconcile its exact accessor policy, and delete non-serving browser revision metadata;
6. require explicit zero active/idle counts for old browser revisions, including deleted-but-live revisions discovered through Monitoring, and no unfinished pi-orb compute mutations; publish activation only after rechecking serving identity;
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
remain for diagnosis, with ownership/cleanup outcomes in the result. Local
credential scratch is removed on handled exits. Never upload the workspace,
state, saved plans or raw diagnostic directories.

`build-push.sh`, `deploy.sh`, `smoke.sh`, and `smoke-workload-identity.sh` remain
implementation stages for diagnostics; they are not separate operator steps. The native build boots a fresh VM and requires runtime readiness, correct ownership/storage, and disabled Docker services before accepting the image. Release validates its manifest against the exact source commit and project. Rebuild an image independently using `infra/native-vm/README.md`; the accepted manifest and logs remain under `.context/native-image-release/`.

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

The API helper impersonates `pi-orb-debug@...` against the ops service — no IAP
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

Nothing sets that URL by hand. OpenTofu computes it from the Cloud Run v2
deterministic URL scheme and hands the identical string to the `runtime` service
(which mints) and the `issuer` service (which publishes) — so a deploy cannot
ship one without the other, and there is no release step to forget. The issuer
service asserts that the computed value appears in its complete `.urls` set on
every apply; Cloud Run's canonical `.uri` is the separate hashed origin. If that
postcondition ever fails, stop and reconcile `local.oidc_issuer_url` in
`infra/oidc.tf` before releasing, because every token in flight names the value
that failed.

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

- Every `tofu apply` that touches the browser service detaches IAP. Use
  `release.sh`: ordinary errors and signals after apply starts invoke
  `deploy.sh --iap-only`, and success takes the full repair/cleanup path.
- IAP repair is exact, not additive: it preserves unrelated IAP roles but
  replaces every `roles/iap.httpsResourceAccessor` binding with the sole
  `domain:heyglide.com` member and verifies the resulting policy before
  revision cleanup or smoke.
- During a revision rollover the draining instance's reconciler keeps running
  with the previous host specification for 12+ minutes — not ~2 — and used to
  fight the new revision over orb VMs (see
  docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md). Two
  defenses now: an apply carrying a larger `deploy_generation` fences host
  replacement forward-only, and `deploy.sh` deletes drained revisions of the browser
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
