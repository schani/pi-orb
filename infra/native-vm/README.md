# Native GCE image

Install the repository's pinned dependencies, then run the image regeneration
command from the checkout root:

```sh
npm ci
npm run native-image:build -- \
  --project playground-dev-6ae7 \
  --zone us-central1-a \
  --base-image projects/debian-cloud/global/images/debian-12-bookworm-v20261027 \
  --version v20260905-1 \
  --subnet projects/playground-dev-6ae7/regions/us-central1/subnetworks/pi-orb-image-build-us-central1 \
  --builder-service-account pi-orb-image-builder@playground-dev-6ae7.iam.gserviceaccount.com \
  --validation-service-account pi-orb-orb-vm@playground-dev-6ae7.iam.gserviceaccount.com \
  --validation-repository-url https://github.com/octocat/Hello-World
```

Apply the foundation first (`infra/foundation/README.md`); its outputs supply
the build subnet and service accounts.

Required local tools are Node.js 26.13.0 LTS, npm, Git, tar, `ssh-keygen`, and an authenticated
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

Installation checks the pinned Claude SDK native executable with `--version`,
without authentication or inference, and records `/opt/pi-orb/claude-sdk-version`.
This verifies packaging, not subscription login or agent behavior.

The command creates the builder, runs installation and guest contract tests,
captures inventory, seals the runtime image, and creates a separate empty 50 GiB
ext4 workspace image. Validation clones that image into a 50 GiB disk, matching
production's fixed workspace capacity, runs `/opt/pi-orb/acceptance.sh`, and verifies the exact
validator instance's `runtime ready` record in Cloud Logging. Validator readiness
polls SSH, HTTP health and the runtime-ready guest attribute for up to 60 attempts.
Guest/Claude acceptance runs once; any failure, including ambiguous transport
loss, rejects the candidate. Never replay assertions until green; preserve the
failed outcome, private logs and cleanup evidence. Acceptance identifies the
supervisor's declared runtime entry argv, not a dynamically imported role module;
a missing child reports `native_runtime_entry_missing`, other failed assertions
only `native_acceptance_failed` plus their source line
(`docs/postmortems/2026-10-09-native-runtime-entry-acceptance.md`). There are no
operator SSH stages.
SSH and SCP always name `pi-orb-build`, never the caller's local username or runtime
`orb`. Preflight generates an unencrypted Ed25519 key
in the operation's mode-0700 `build-ssh` directory with no prompt; all connections
use that key, IAP, quiet mode and SSH batch mode. Existing directories are refused,
not overwritten. Cleanup removes the operation key on success, failure and handled
cancellation, after remote diagnostics and resource cleanup. A trap-bypassing kill
can leave the private key in the private evidence directory; verify ownership and
remove it when recovering the interrupted build. No personal SSH key is needed.
A pre-created runtime `orb` account breaks image installation
(`docs/postmortems/2026-09-08-orb-local-release-builder-user.md`).

Host keys follow the guest gate in `docs/host-provider.md`; package or
effective-unit drift fails sealing. Readiness and acceptance compare the recorded fingerprint while strict
checking authenticates each connection; a confirmed mismatch is terminal
(`docs/postmortems/2026-09-20-validator-host-key-change.md`).

Sealing retains the build administrator with a locked password and no copied SSH
credentials. It stops (but does not disable) guest-account reconciliation before
scrubbing keys so instance metadata cannot repopulate them before capture. At the
validator's boot these services restart and accept only the new instance's SSH
metadata. Acceptance checks the separate administrator home and locked password,
plus runtime `orb`'s UID/GID 2000 and `/workspace/home`; it does not adopt a
pre-existing runtime account with arbitrary ownership.

Workspace capacity is fixed at 50 GiB in the builder, validator and provider; there
is no workspace-size option or runtime growth path, because a read-only `e2fsck`
does not establish the check state `resize2fs` needs
(`docs/postmortems/2026-09-08-workspace-image-readonly-check.md`). The builder runs
a forced read-only `e2fsck` after the empty template's final unmount and refuses a
damaged candidate. Guest admission: `docs/host-provider.md`. The Linux tests cover fixed-size admission,
retained contents, mismatch refusal without mutation and the template integrity
gate with real e2fsprogs.

Output defaults to `.context/native-image/<version>-<operation-id>/`. Every
external command has a numbered log. The accepted `manifest.json` records:

```json
{
  "schemaVersion": 2,
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
  "workspaceImageId": "NUMERIC_GCE_ID",
  "validationHostKeyFingerprint": "SHA256:BASE64"
}
```

Standalone builds may accept a dirty source snapshot because its exact contents
remain recorded. Releases reject `sourceDirty: true`. The sanitized validator
fingerprint is also printed in the build summary retained by GitHub Actions; raw
SSH output remains only in private command logs.

Image capture submits create once. An explicit transient create failure permits
read-only reconciliation only: at most 12 describes within 60 seconds (five-second
waits, ten-second reads, clipped to one injected deadline that also bounds log
persistence). Transient reads, exact-resource absence and owned `PENDING` images
retry; other errors fail closed. Ordinary and recovered captures both require exact
project/name/selfLink, operation/version labels, source disk/zone, numeric ID and
`READY`, and pin the observed ID; a validated `PENDING` create response enters the
same bounded recovery, fencing the numeric ID before the first describe. Rejection
or exhaustion cleans owned resources and never inserts again. Blind create replay
is rejected (`docs/postmortems/2026-10-24-native-image-capture-502.md`,
`docs/postmortems/2026-11-05-native-capture-pending.md`).

On failure or interruption, `failure.json`, the source archive, command logs,
and available serial/journal evidence remain locally. Cleanup checks the unique
operation label and expected name before each deletion and refuses foreign
resources. Before that ownership check, it lists already-visible pending GCE
operations for the exact target and waits up to one minute for them to finish.
A list, wait, or pending-operation timeout blocks acceptance and remains in the
evidence; cleanup does not claim to catch an operation registered after its list.
It deletes validator and builder instances before the validation and template
disks. Each deletion durably records the exact target first; a matching in-flight
create is observed for at most 60 seconds before ownership is rechecked. A
non-logging `gcloud auth print-access-token` (30 s, `SIGKILL` on timeout) precedes
one plain Compute REST `DELETE` (30 s, no redirects, no replay); the returned
operation's target and scope are validated and persisted before polling only that
operation for at most 12 minutes. `DONE` without an error succeeds; a reported
error fails; malformed, lost, cancelled or interrupted evidence is `uncertain` and
is never resubmitted automatically. (`gcloud compute … delete` is synchronous and
rejects `--async`.) Cleanup never holds the release lock indefinitely
(`docs/postmortems/2026-09-16-validator-cleanup-timeout.md`). Cancellation waits:
each wrapper terminates its direct child and waits for its cleanup
(`docs/postmortems/2026-09-07-native-build-cancellation-cleanup.md`). A candidate that fails validation has both images deleted and never
receives an accepted manifest. `--output-dir` selects another private evidence directory.
