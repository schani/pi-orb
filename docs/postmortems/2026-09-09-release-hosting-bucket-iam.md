# Scoped release blocked reading the hosted-files bucket

## Finding (2026-09-09)

The requested changes were committed, rebased onto `8656e2b`, and pushed as `b36c160`. The rebased tree passed typecheck, lint, 1,523 tests (with the suite's normal skips), and all 65 Docker/PostgreSQL/browser E2E tests.

The supported `infra/release.sh --yes` transaction successfully built and accepted native image `pi-orb-image-v-b36c160-ec1f86ff2c964bfd`, validated its 50 GiB workspace template and guest runtime, and published control-plane digest `sha256:c626572e25925afd10281a42650ddc9582bcab9a5c4e1857c79978fdda24b52e`. The release's child PATH used the corrected checkout identity CLI while retaining the reviewed credential helper; no one-shot OAuth token override was used.

The application OpenTofu plan then failed while refreshing `google_storage_bucket.hosting`:

`pi-orb-amp-deployer@playground-dev-6ae7.iam.gserviceaccount.com` lacks `storage.buckets.get` on `pi-orb-hosting-playground-dev-6ae7`.

`infra/hosting.tf` makes the hosting bucket and control-plane object-access grant application-root resources, but `infra/foundation/iam.tf` grants the recurring deployer Storage access only on the state bucket. The scoped identity's previously validated image-build and Artifact Registry authority does not imply access to this separate application resource. The exact missing permission was observed; further bucket/IAM permissions must be reviewed against the application resources rather than inferred from one successful read.

## Correction and verification (2026-09-09)

Under the human's temporary administrator login, a reviewed foundation plan added exactly four resources (two custom roles and two member bindings), changing or deleting no existing resource. `piOrbHostingBucketManager` grants `storage.buckets.get`, `update`, `delete`, `getIamPolicy`, and `setIamPolicy`, conditioned on the exact hosting-bucket resource name and type. `piOrbHostingBucketCreator` grants only `storage.buckets.create` at project scope. GCS checks creation on the project, so a future bucket name cannot scope that operation. This preserves fresh-project release capability without granting blanket Storage administration. Neither role directly includes object permissions; bucket IAM management nevertheless permits changing access to this bucket's files.

The existing project-attribute provider condition and `principalSet` already admitted all repository-project orbs. The committed executable hooks and non-secret credential template required no changes. Running the real `.agents/resume` twice in an empty HOME and gcloud configuration proved idempotency, project/hosting-bucket reads and all five management permissions. Negative permission checks confirmed the deployer cannot update/delete the state bucket, change its IAM, or set project IAM. Bucket creation permission was checked without creating another bucket. The application plan then succeeded under that isolated federated identity, proposing only updates to the four Cloud Run services. It was a read-only probe using the accepted `b36c160` artifacts, not an application apply or a substitute for the supported release.

The normal orb configuration was restored through the same resume hook, the temporary personal login was revoked, and a subsequent hosting-bucket read still succeeded as the shared deployer. No personal refresh token was copied to project secrets or other orbs. The grant is durable in foundation state and applies to every admitted project orb. Source contract tests pin the permission sets and exact-name management condition. Evidence: `.context/foundation-access/{plan,apply,verify,isolated-application-plan,resume}.log`; private saved plans and the temporary verification home were removed. Google IAM Admin Activity and versioned foundation state retain the cloud-side changes.

## Containment and authority boundary

No application apply was attempted. No Cloud Run traffic, IAP policy or database change was made by this release. Builder/validator compute, temporary disks and build SSH keys were cleaned up normally. The global release lock was removed; no release process remained. The accepted image artifacts remain published.

Evidence is in `.context/release-b36c160/release.log`, with the accepted native manifest under `.context/native-image-release/20260909T022107Z-v-b36c160/`. Temporary OpenTofu variables/plans were removed by the release trap.

The recurring deployer intentionally cannot update its own foundation IAM grants. Correct the reviewed foundation permissions under a separate bootstrap/admin identity, then verify the ordinary deployer and rerun the supported release. Do not bypass the failed plan, skip IAP reconciliation, grant broad project Storage administration as a shortcut, or switch to another identity merely because it can evade this boundary. The correction below preserves that boundary.
