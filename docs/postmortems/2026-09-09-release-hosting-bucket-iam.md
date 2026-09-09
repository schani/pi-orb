# Scoped release blocked reading the hosted-files bucket

## Finding (2026-09-09)

The requested changes were committed, rebased onto `8656e2b`, and pushed as `b36c160`. The rebased tree passed typecheck, lint, 1,523 tests (with the suite's normal skips), and all 65 Docker/PostgreSQL/browser E2E tests.

The supported `infra/release.sh --yes` transaction successfully built and accepted native image `pi-orb-image-v-b36c160-ec1f86ff2c964bfd`, validated its 50 GiB workspace template and guest runtime, and published control-plane digest `sha256:c626572e25925afd10281a42650ddc9582bcab9a5c4e1857c79978fdda24b52e`. The release's child PATH used the corrected checkout identity CLI while retaining the reviewed credential helper; no one-shot OAuth token override was used.

The application OpenTofu plan then failed while refreshing `google_storage_bucket.hosting`:

`pi-orb-amp-deployer@playground-dev-6ae7.iam.gserviceaccount.com` lacks `storage.buckets.get` on `pi-orb-hosting-playground-dev-6ae7`.

`infra/hosting.tf` makes the hosting bucket and control-plane object-access grant application-root resources, but `infra/foundation/iam.tf` grants the recurring deployer Storage access only on the state bucket. The scoped identity's previously validated image-build and Artifact Registry authority does not imply access to this separate application resource. The exact missing permission was observed; further bucket/IAM permissions must be reviewed against the application resources rather than inferred from one successful read.

## Containment and authority boundary

No application apply was attempted. No Cloud Run traffic, IAP policy or database change was made by this release. Builder/validator compute, temporary disks and build SSH keys were cleaned up normally. The global release lock was removed; no release process remained. The accepted image artifacts remain published.

Evidence is in `.context/release-b36c160/release.log`, with the accepted native manifest under `.context/native-image-release/20260909T022107Z-v-b36c160/`. Temporary OpenTofu variables/plans were removed by the release trap.

The recurring deployer intentionally cannot update its own foundation IAM grants. Correct the reviewed foundation permissions under a separate bootstrap/admin identity, then verify the ordinary deployer and rerun the supported release. Do not bypass the failed plan, skip IAP reconciliation, grant broad project Storage administration as a shortcut, or switch to another identity merely because it can evade this boundary. Action is tracked in `TODO.md`.
