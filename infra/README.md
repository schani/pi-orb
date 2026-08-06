# pi-orb cloud deployment

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
Services: `pi-orb` (browser, IAP: @heyglide.com), `pi-orb-runtime-api`
(internal broker), `pi-orb-ops` (tooling; invoker-IAM: pi-orb-debug SA).

## Deploy workflow

    ./infra/build-push.sh          # builds+pushes both images, prints the
                                   # digest vars + a fresh deploy_generation
    cd infra && tofu apply -var control_plane_image=... -var runtime_image=... \
      -var deploy_generation=...   # must increase every deploy: it fences
                                   # startup-script repairs forward-only
    ./infra/deploy.sh              # ALWAYS after apply: re-enables IAP (the
                                   # provider version cannot manage it yet)
    ./infra/smoke.sh               # create -> running -> stop -> start -> stop
                                   # against the live deployment; the restart
                                   # leg is what catches rollover repair wars
                                   # and corrupt runtime image caches (~5 min)

`build-push.sh` boots the freshly built runtime image locally and requires it
to answer `/v1/health` before anything is pushed — Cloud Run already fails a
control-plane rollout loudly, but nothing downstream ever verifies the runtime
artifact.

## Tooling access

    ./infra/api.sh /api/v1/projects
    ./infra/api.sh /api/v1/orbs/<id>/start '{}'

Impersonates `pi-orb-debug@...` against the ops service — no IAP involved.

## Gotchas (each learned the hard way)

- Every `tofu apply` that touches the browser service detaches IAP; run
  `deploy.sh` immediately after.
- During a revision rollover the draining instance's reconciler keeps running
  with the previous startup-script generation for 12+ minutes — not ~2 — and
  used to fight the new revision over orb VMs (dueling script repairs; see
  docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md). Two
  defenses now: an apply carrying a larger `deploy_generation` fences repairs
  forward-only, so the old revision can no longer repair backward, and
  `deploy.sh` deletes drained revisions of the browser service. Forgetting the
  var is safe but degrading: that revision deploys at generation 0 and never
  repairs hosts stamped by earlier deploys — hosts keep booting the old script
  until the next apply that does pass a generation.
- Workspace session policy expires gcloud user credentials roughly daily:
  `gcloud auth login` interactively when everything returns empty/errors.
- Orb VM boot diagnostics: `gcloud compute instances get-guest-attributes
  <vm> --query-path=pi-orb/startup`; serial console as fallback.
- Cloud SQL has deletion protection; `tofu destroy` will refuse it by design.
