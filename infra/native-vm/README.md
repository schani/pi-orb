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

Required local tools are Node.js 24, npm, Git, tar, `ssh-keygen`, and an authenticated
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
captures inventory, seals the runtime image, and creates a separate empty 50 GiB
ext4 workspace image. Validation clones that image into a 50 GiB disk, matching
production's fixed workspace capacity, runs `/opt/pi-orb/acceptance.sh`, and verifies the exact
validator instance's `runtime ready` record in Cloud Logging. Validator SSH
readiness and guest acceptance each retain 60 attempts, so boot connectivity
does not consume the acceptance allowance. There are no
operator SSH stages. SSH and SCP always name `pi-orb-build`, never the caller's
local username or runtime `orb`. Preflight generates an unencrypted Ed25519 key
in the operation's mode-0700 `build-ssh` directory with no prompt; all connections
use that key, IAP, quiet mode and SSH batch mode. Existing directories are refused,
not overwritten. Cleanup removes the operation key on success, failure and handled
cancellation, after remote diagnostics and resource cleanup. A trap-bypassing kill
can leave the private key in the private evidence directory; verify ownership and
remove it when recovering the interrupted build. No personal SSH key is needed.

Sealing retains the build administrator with a locked password and no copied SSH
credentials. It stops (but does not disable) guest-account reconciliation before
scrubbing keys so instance metadata cannot repopulate them before capture. At the
validator's boot these services restart and accept only the new instance's SSH
metadata. Acceptance checks the separate administrator home and locked password,
plus runtime `orb`'s UID/GID 2000 and `/workspace/home`; it does not adopt a
pre-existing runtime account with arbitrary ownership.

Workspace capacity is fixed at 50 GiB in the builder, validator and provider; there
is no workspace-size option or runtime growth path. The builder runs a forced
read-only `e2fsck` after the empty template's final unmount and refuses a damaged
candidate. Guest admission only reads disk capacity, filesystem type and size,
requiring a 50 GiB ext4 filesystem that fills a 50 GiB disk before mounting. It
never formats, resizes or repairs a retained disk, and does not add an offline
check to ordinary restarts; normal ext4 mount/journal handling remains unchanged.
Wrong-size or malformed storage emits the precise workspace failure code through
the existing boot diagnostics. The Linux tests cover fixed-size admission,
retained contents, mismatch refusal without mutation and the template integrity
gate with real e2fsprogs.

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
  "imageId": "NUMERIC_GCE_ID",
  "workspaceImageResource": "projects/PROJECT/global/images/NAME",
  "workspaceImageId": "NUMERIC_GCE_ID"
}
```

Standalone builds may accept a dirty source snapshot because its exact contents
remain recorded. Releases reject `sourceDirty: true`.

On failure or interruption, `failure.json`, the source archive, command logs,
and available serial/journal evidence remain locally. Cleanup checks the unique
operation label and expected name before each deletion and refuses foreign
resources. Before that ownership check, it lists already-visible pending GCE
operations for the exact target and waits up to one minute for them to finish.
A list, wait, or pending-operation timeout blocks acceptance and remains in the
evidence; cleanup does not claim to catch an operation registered after its list.
It deletes validator and builder instances before the validation and template
disks. A candidate that fails validation has both images deleted and never
receives an accepted manifest. `--output-dir` selects another private evidence directory.
