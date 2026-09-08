# Native GCE image

Install the repository's pinned dependencies, then run the image regeneration
command from the checkout root:

```sh
npm ci
npm run native-image:build -- \
  --project playground-dev-6ae7 \
  --zone us-central1-a \
  --base-image projects/debian-cloud/global/images/debian-12-bookworm-v20260902 \
  --version v20260905-1 \
  --subnet projects/playground-dev-6ae7/regions/us-central1/subnetworks/pi-orb-image-build-us-central1 \
  --builder-service-account pi-orb-image-builder@playground-dev-6ae7.iam.gserviceaccount.com \
  --validation-service-account pi-orb-orb-vm@playground-dev-6ae7.iam.gserviceaccount.com \
  --validation-repository-url https://github.com/octocat/Hello-World
```

Apply the foundation first (`infra/foundation/README.md`); its outputs supply
the build subnet and service accounts.

Required local tools are Node.js 24, npm, Git, tar, and an authenticated
`gcloud`. The caller needs IAP SSH, Compute instance/disk/image
create/inspect/delete, Logging viewer, image IAM publication, and
`iam.serviceAccounts.actAs` permissions. The builder service account needs only
the guest's build-time access, including Logging writer. The validation account
is the restricted orb VM identity; it receives no image publication authority.

Supply an exact Debian image resource and a fresh lowercase version. Before any
cloud mutation, the command snapshots every uploaded source file, verifies that
the live inputs did not change during capture, and records the archive SHA-256,
per-file SHA-256 inventory, separate builder-tool inventory, full Git commit,
and dirty-tree state. Git-ignored files, dependencies, and extended macOS metadata are excluded;
source symlinks are rejected. The uploaded archive is never regenerated during
the run.

The command creates the builder, runs installation and guest contract tests,
captures inventory, seals the image, boots a candidate with a fresh blank
workspace disk, runs `/opt/pi-orb/acceptance.sh`, and verifies the exact
validator instance's `runtime ready` record in Cloud Logging. There are no
operator SSH stages.

Output defaults to `.context/native-image/<version>-<operation-id>/`. Every
external command has a numbered log. The accepted `manifest.json` records:

```json
{
  "schemaVersion": 1,
  "status": "accepted",
  "validation": true,
  "sourceCommit": "FULL_40_CHARACTER_GIT_SHA",
  "sourceDirty": false,
  "sourceArchiveSha256": "SHA256",
  "baseImageResource": "projects/PROJECT/global/images/NAME",
  "baseImageId": "NUMERIC_GCE_ID",
  "imageResource": "projects/PROJECT/global/images/NAME",
  "imageId": "NUMERIC_GCE_ID"
}
```

Standalone builds may accept a dirty source snapshot because its exact contents
remain recorded. Releases reject `sourceDirty: true`.

On failure or interruption, `failure.json`, the source archive, command logs,
and available serial/journal evidence remain locally. Cleanup checks the unique
operation label and expected name before each deletion and refuses foreign
resources. It deletes validator and builder instances before the validation
disk. A candidate that fails validation is deleted and never receives an
accepted manifest. `--output-dir` selects another private evidence directory.
