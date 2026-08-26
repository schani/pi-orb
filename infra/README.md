# pi-orb cloud deployment

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
Services: `pi-orb` (browser, IAP: @heyglide.com), `pi-orb-runtime-api`
(internal broker), `pi-orb-ops` (tooling; invoker-IAM: pi-orb-debug SA),
`pi-orb-issuer` (public OIDC discovery + JWKS, unauthenticated by design; its own
service account, which can read no signing key and no brokered credential — but
does share the one read/write database credential, `docs/deployment.md`).

## Deploy workflow

The supported manual deployment is one command from the repository root:

    ./infra/release.sh

It requires a clean `main` checkout exactly matching freshly fetched
`origin/main`, shows the exact OpenTofu plan, and requires typing `deploy` before
applying. `./infra/release.sh --yes` is the non-interactive form intended for a
future serialized CI job. The script owns the complete transaction:

1. build and push both digest-pinned images after the runtime boot gate;
2. clamp `deploy_generation` above the generation currently serving in Cloud
   Run, then create and apply an exact saved OpenTofu plan;
3. repair IAP after every attempted apply (`deploy.sh --iap-only` on apply
   failure), and after success delete drained browser revisions;
4. run the live create → running → stop → start → stop smoke test;
5. run the live workload-identity smoke (`smoke-workload-identity.sh`).

Generated variables and the binary plan live under `umask 077` in a mode-0700
temporary directory and are removed on exit; they must never be retained because
OpenTofu plans embed state secrets. A generation-matched object at
`gs://pi-orb-tfstate-<project>/static-plane/release.lock` serializes the complete
manual transaction across workstations and runners; a same-workstation lock
fails even earlier. The object records only commit, host, PID, and start time.
If a process is killed without running traps and leaves the object behind,
verify no release is active before removing that object. The future GitHub
workflow must use the same lock in addition to its native concurrency group.

`build-push.sh`, `deploy.sh`, `smoke.sh`, and `smoke-workload-identity.sh` remain
implementation stages for diagnostics; they are not separate operator steps. `build-push.sh` boots the
freshly built runtime image locally and requires it to answer `/v1/health`
before anything is pushed — Cloud Run already fails a control-plane rollout
loudly, but nothing downstream ever verifies the runtime artifact.

## Tooling access

Project orbs install the Google Cloud CLI and configure keyless authentication
via `.agents/setup`. The setup exchanges a short-lived Amp OIDC token for the
dedicated `pi-orb-amp-deployer` service account; there is no stored service
account key or recurring browser login. Trust is restricted to this immutable
Amp project ID and the approved Amp user ID. Verify the active identity and
project before using the tooling:

    gcloud auth list
    gcloud config get-value project

    ./infra/api.sh /api/v1/projects
    ./infra/api.sh /api/v1/orbs/<id>/start '{}'

Impersonates `pi-orb-debug@...` against the ops service — no IAP involved.

The federation pool/provider and deployer permissions are a separately
bootstrapped trust boundary, intentionally outside the recurring OpenTofu root.
`infra/bootstrap-amp-oidc.sh` records and idempotently applies that bootstrap
from an existing administrator identity; ordinary releases never invoke it.
The deployer has functional roles for the root's static-plane resources rather
than Owner or Editor, object access only on the static-plane state bucket, and
token creation only on the debug service account. `.agents/setup` writes the
non-secret external-account configuration under the gitignored `.amp/`
directory; its reviewed executable credential source is
`scripts/amp-gcp-identity`.

The current OpenTofu root manages project IAM, so full deployment access is
necessarily escalation-capable even without Owner or Editor: a compromised
deployer could alter project bindings. Moving stable IAM/bootstrap resources
out of the recurring root is required before this becomes a least-privilege
production deployment identity.

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
dies at STS; unset, those legs skip with a loud notice. Both orbs are deleted on
exit, pass or fail. No token is ever printed: they move through pipes and
mode-0600 files in a mode-0700 directory removed on exit.

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
  with the previous startup-script generation for 12+ minutes — not ~2 — and
  used to fight the new revision over orb VMs (dueling script repairs; see
  docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md). Two
  defenses now: an apply carrying a larger `deploy_generation` fences script
  repairs forward-only, and `deploy.sh` deletes drained revisions of the browser
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
