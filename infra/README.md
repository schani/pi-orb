# pi-orb cloud deployment

Project `playground-dev-6ae7`, region `us-central1`, zone `us-central1-a`.
Services: `pi-orb` (browser, IAP: @heyglide.com), `pi-orb-runtime-api`
(internal broker), `pi-orb-ops` (tooling; invoker-IAM: pi-orb-debug SA).

## Deploy workflow

    ./infra/build-push.sh          # builds+pushes both images, prints digest vars
    cd infra && tofu apply -var control_plane_image=... -var runtime_image=...
    ./infra/deploy.sh              # ALWAYS after apply: re-enables IAP (the
                                   # provider version cannot manage it yet)

## Tooling access

    ./infra/api.sh /api/v1/projects
    ./infra/api.sh /api/v1/orbs/<id>/start '{}'

Impersonates `pi-orb-debug@...` against the ops service — no IAP involved.

## Gotchas (each learned the hard way)

- Every `tofu apply` that touches the browser service detaches IAP; run
  `deploy.sh` immediately after.
- During a revision rollover the draining instance's reconciler can create
  orb VMs with the previous startup script (DESIGN.md §3.3 caveat, open
  question 32). Wait ~2 minutes after deploying before restarting orbs.
- Workspace session policy expires gcloud user credentials roughly daily:
  `gcloud auth login` interactively when everything returns empty/errors.
- Orb VM boot diagnostics: `gcloud compute instances get-guest-attributes
  <vm> --query-path=pi-orb/startup`; serial console as fallback.
- Cloud SQL has deletion protection; `tofu destroy` will refuse it by design.
