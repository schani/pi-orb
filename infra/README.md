# pi-orb cloud deployment

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
Services: `pi-orb` (browser, IAP: @heyglide.com), `pi-orb-runtime-api`
(internal broker), `pi-orb-ops` (tooling; invoker-IAM: pi-orb-debug SA).

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
4. run the live create → running → stop → start → stop smoke test.

Generated variables and the binary plan live under `umask 077` in a mode-0700
temporary directory and are removed on exit; they must never be retained because
OpenTofu plans embed state secrets. A generation-matched object at
`gs://pi-orb-tfstate-<project>/static-plane/release.lock` serializes the complete
manual transaction across workstations and runners; a same-workstation lock
fails even earlier. The object records only commit, host, PID, and start time.
If a process is killed without running traps and leaves the object behind,
verify no release is active before removing that object. The future GitHub
workflow must use the same lock in addition to its native concurrency group.

`build-push.sh`, `deploy.sh`, and `smoke.sh` remain implementation stages for
diagnostics; they are not separate operator steps. `build-push.sh` boots the
freshly built runtime image locally and requires it to answer `/v1/health`
before anything is pushed — Cloud Run already fails a control-plane rollout
loudly, but nothing downstream ever verifies the runtime artifact.

## Tooling access

    ./infra/api.sh /api/v1/projects
    ./infra/api.sh /api/v1/orbs/<id>/start '{}'

Impersonates `pi-orb-debug@...` against the ops service — no IAP involved.

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
