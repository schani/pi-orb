# Workspace image growth refused after a successful read-only check

## Finding (2026-09-08)

The disposable native image build `v-ssh-fix-20260908-ed19cd3cee054cc9` validated the correction to the orb-local SSH account collision: installation, sealing, runtime image capture, validator creation and explicit-administrator SSH all succeeded. The validator had runtime `orb` UID/GID 2000 with home `/workspace/home`, and a distinct UID-1000 `pi-orb-build` with home `/home/pi-orb-build` and a locked password.

The complete guest acceptance gate did **not** pass. `pi-orb-workspace.service` reported `filesystem_resize_failed`; the workspace mount and runtime service consequently never started. Direct diagnosis on that disposable validator reproduced the production preparation sequence:

- `e2fsck -f -n /dev/disk/by-id/google-pi-orb-data` completed all five passes and exited 0.
- `resize2fs /dev/disk/by-id/google-pi-orb-data` exited 1, asking to run `e2fsck -f` first.

Both tools were e2fsprogs 1.47.0. This establishes that passing our read-only check does not necessarily satisfy resize2fs's persistent check-state requirement. It does not justify automatically repairing a potentially damaged retained workspace. The template creation path mounts and unmounts the newly formatted filesystem before image capture; reproduction must include that history rather than only a freshly formatted regular-file fixture.

## Evidence and containment

The original build log is `.context/deploy/ssh-fix-live.log`; command, serial and guest logs are under `.context/native-image/v-ssh-fix-20260908-ed19cd3cee054cc9/`. The direct check/resize output is `.context/deploy/ssh-fix-workspace-diagnostic.log`. No assertion or timeout was weakened, and the build was not rerun to seek green. After diagnosis, the builder CLI received SIGTERM so its owned cleanup could run rather than continuing acceptance polling against a terminally failed guest. Cleanup completed for both instances, both disks, both candidate images and the local build SSH key; a subsequent operation-label inventory found no remaining cloud resources. No accepted manifest or production deployment resulted.

## Local reproduction and narrower correction (2026-09-08)

A separate scratch-disk experiment reproduced the failure with real e2fsprogs 1.47.0 and a kernel loop mount. It created a 10 GiB ext4 image, mounted and unmounted it as the builder does, copied the template, expanded the copy to 20 GiB, and ran the unchanged `e2fsck -f -n` → `resize2fs` sequence. The read-only check exited 0; resize exited 1 asking for `e2fsck -f`. The experiment explicitly crossed ext4's one-second timestamp boundary before mounting so the result did not depend on command execution speed.

On the original fresh empty template, a successful read-only gate followed by `e2fsck -f -p` exited 0. Copying and enlarging that template then passed the same read-only check and resized successfully. Evidence: `.context/deploy/reproduce-workspace-resize.py` and `.context/deploy/reproduce-workspace-resize.log`. All scratch images and loop mounts were cleaned up.

**Proposed correction, not implemented:** after the builder's final template unmount, run a forced read-only check and require exit 0, then a forced writable noninteractive check and again require exactly exit 0 before capture. This establishes check metadata on a newly generated, disposable, empty template; reject any detected correction/error rather than publishing it. Keep the runtime's read-only integrity gate unchanged. This proposal addresses template-clone initial growth; it does not establish arbitrary later growth of a retained user filesystem. An alternative is removing the builder's temporary mount and verifying emptiness without mounting; that needs its own equivalent validation and growth test. Never use `resize2fs -f` to bypass the check or add unconditional repair to retained-workspace boot.

The previous real-filesystem test formats and enlarges a regular-file image without the intervening mount/unmount. It therefore misses the history that makes the captured template fail. Add that exact history to the regression, including explicit timestamp synchronization, then rerun real GCE acceptance after implementing the correction.

## Phase and capacity clarification (2026-09-08)

The failure was in guest startup on the disposable validation VM, after runtime and workspace image capture succeeded, but before image acceptance and production application deployment. It was not an installer failure on the builder or an observed resize of an existing production orb. Native orbs here are GCE VMs, not Kubernetes pods.

The current capacities differ deliberately in validation: the workspace template is 10 GiB, the validator's disk is 20 GiB to exercise growth, and the provider's production workspace default is 50 GiB. Creating a 20 GiB template would remove the validator's initial growth but not production's 20 → 50 GiB growth. A smaller template is an implementation choice, not a fundamental requirement. **Alternative proposal:** if workspaces are standardized at 50 GiB, use a 50 GiB template and validate that same production shape, eliminating initial growth from that launch path. This narrows the current provider's configurable size contract; provisioning larger disks would still need growth. It is an alternative to the proposed final-template check, not a selected change.

**Cost/constraint evaluation (2026-09-08):** production already provisions and pays for the complete 50 GiB workspace from creation; the 10 GiB figure describes the template filesystem, not a cheaper initial production disk. A 50 GiB template therefore adds no production workspace-capacity charge. At the Iowa `pd-balanced` rate recorded in `docs/deployment.md` (about $0.10/GiB-month), increasing the temporary builder template disk from 10 to 50 GiB and validator disk from 20 to 50 GiB adds about $0.01 if both incremental capacities are held for a full hour. Custom image storage is billed on stored compressed image size, not the template's nominal filesystem capacity; the measured 10 GiB empty template is only 67,328 compressed bytes, and the 50 GiB template's stored size/build duration have not been measured. The practical tradeoff is minimum target disk size: a 50 GiB image cannot create a smaller workspace, and validator configuration must match. Formatting/checking a larger template may add build-time metadata work, but retaining a small template is not justified by any demonstrated production capacity saving.

## Selected simplification (decided and implemented 2026-09-08)

The user selected fixed-size 50 GiB workspace construction instead of either growth workaround. The builder's empty template and validator disk now match production's existing 50 GiB capacity. The provider no longer exposes a configurable workspace size. Runtime admission reads disk capacity, ext4 type and filesystem size and requires exact equality at 50 GiB; the resize operation, growth outcome and conditional pre-growth filesystem check were removed. Mismatches emit explicit `disk_size_mismatch` or `filesystem_size_mismatch` boot diagnostic codes rather than silently altering storage.

The template builder retains a forced read-only integrity gate after its last unmount. There is no need to update writable check metadata because nothing resizes that filesystem anymore. Retained-disk admission follows the former same-size path: no new offline integrity scan, formatting or repair on every restart; ext4's normal mount/journal handling remains unchanged. This avoids turning an unclean but normally recoverable restart into a new mandatory offline-repair workflow. Metadata admission does not claim to detect arbitrary file-content corruption; damaged candidate images are rejected by the build-time integrity gate, and mount failure is propagated through existing boot diagnostics.

Tests now cover fixed-size builder/validator/provider requests, rejected smaller/larger disks and filesystems without writes, retained sentinel contents and stale mount/check metadata, the empty-template integrity gate, and precise guest diagnostic codes. The earlier growth proposal and local experiment are retained above as rationale/evidence, not unfinished implementation instructions. Simplicity is now an explicit planning/building criterion in `AGENTS.md`.

## Live validation of the simplified path (2026-09-08)

Disposable build `v-fixed-workspace-20260908-a28c6fb5b1e24029` passed the complete native GCE acceptance gate: 50 GiB template construction and read-only integrity check, capture, a 50 GiB validator disk, exact image identity checks, guest acceptance, runtime readiness, and the durable Cloud Logging gate. The run took 7 minutes 34 seconds (20:47:21.858–20:54:55.966 UTC). It used the scoped deployment identity; only this build's PATH selected the corrected checkout identity CLI, retaining the reviewed credential helper and ordinary refresh behavior without exporting a one-shot OAuth access token.

The accepted workspace image ID was `6074594630275288036`, logical disk size 50 GiB, compressed storage **160,256 bytes (156.5 KiB)**. For comparison, the earlier 10 GiB template measured 67,328 compressed bytes. The increase is 92,928 bytes, not 40 GiB of stored image data. Image-size evidence is `.context/fixed-workspace/workspace-image.json`; the manifest and command logs are under `.context/native-image/v-fixed-workspace-20260908-a28c6fb5b1e24029/`, including `040-validate-gcloud.log` with `native_guest_acceptance_passed`.

The source was an explicitly dirty standalone snapshot of the implementation atop `770b6a3`, not a production release. All builder/validator instances, temporary disks, SSH keys and both accepted test images were removed after preserving evidence and checking their exact ownership/identity; the operation-label inventory is empty. Typecheck, lint, unit/infrastructure tests and all 65 Docker/PostgreSQL/browser E2E tests passed. No production application apply occurred.

## Rule

Validate the exact production shape: a 50 GiB filesystem on a 50 GiB workspace disk. Do not reintroduce a resize path merely to test it. Preserve retained data and refuse unsupported capacity rather than adding compatibility machinery. The observed distinction between read-only inspection and resize eligibility remains historical evidence for why the original design failed.
