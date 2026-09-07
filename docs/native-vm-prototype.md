# Native Debian VM prototype — 2026-09-05

The experiment runs the existing orb runtime directly under systemd, with Docker
available to an ordinary `orb` user. Production remains unchanged. The selected
direction and remaining release choices are in `docs/host-provider.md` and
`docs/open-questions.md`, question 48.

## Initial run: scope and artifacts

Project `playground-dev-6ae7`, zone `us-central1-a`; disposable, labelled
`pi-orb-experiment=native-vm-riga-0905`. On-demand `n2d-highmem-4` VMs avoid Spot
preemption during deterministic acceptance. Boot disks are disposable 20 GB disks;
one separately formatted 50 GB `pd-balanced` disk is retained at `/workspace`.

`infra/native-vm/` contains the image recipe, systemd units, package rationale,
cloud-stage driver, and guest acceptance scripts. `e2e/native-vm/` composes the
stock control plane with a fixed test host adapter and isolated PGlite/model/OAuth
fixtures. The test process disables idle auto-stop so the driver owns uptime.
Its adapter cannot mutate GCP and keeps a fixed logical host reference
while the driver replaces physical VMs. This proves native runtime and storage
behavior, not production provider reconciliation, token rotation, or incarnation
fencing. A small preseeded repository exercises hooks; fresh GitHub cloning is not
part of this run.

Raw logs, manifests, protocol frames, package inventories, browser evidence, and
private fixture state are retained locally under `.context/native-vm/`. The
runbook is `infra/native-vm/README.md`.

## Findings

- The real runtime starts as UID/GID 2000, with passwordless sudo and Docker access.
  Setup receives neither the runtime token nor project secrets; resume receives
  broker-delivered credentials and the fixture project secret. The environment
  file is root-owned mode 0600; persistent home is owned by 2000, mode 0700.
- The browser completes a live WebSocket handshake, agent shell tool, and final
  response. A separate protocol check exercises the same control-plane proxy and
  a real terminal PTY. Chromium/agent-browser, C compilation, Rust compilation,
  Python venv, gh, and gcloud execute on the VM. A userspace Tailscale preview is
  reachable from the Mac. The guest `pi-orb id-token` helper mints through the
  isolated broker; its audience/subject/expiry and RSA signature verify against
  that issuer's JWKS. This does not test external cloud federation.
- Docker 29.1.3 uses containerd 2.3.4's overlayfs image store. Docker's `data-root`
  alone does **not** retain that store: both `/workspace/docker` and
  `/workspace/containerd` are required. `/run` holds transient process/socket state.
- Corrected-storage stop/start preserves the session, home, repository, unpublished
  image identity, stopped-container writes, unattached volume, and checkpointed
  PostgreSQL record. Compose's `unless-stopped` database starts automatically;
  the deliberately stopped container stays stopped. Verification asserts these
  states before invoking Compose. Setup remains once per incarnation; resume runs
  on every runtime start.
- Deleting VM A and its boot disk, then attaching the same data disk to VM B
  from image E, preserves all of those records/files and the original session.
  The old boot-only marker disappears, the image identity changes, and setup runs
  again for incarnation 1. The replacement also passes the protocol/PTY, tool,
  and Tailscale preview checks.
- Killing the runtime with SIGKILL triggers systemd recovery, removes its previous
  child processes, preserves the session, and leaves Docker data intact. Injecting
  a Docker `ExecStartPre=/bin/false` failure leaves the runtime usable. Removing
  that fault recovers the same stores without wiping them.
- A hard GCE reset after PostgreSQL `CHECKPOINT` and `sync` preserves the same
  database record, Docker stores, home/repository, and session. The runtime process
  changes; setup is not repeated and resume runs again. This is one synchronized
  interruption case, not a power-loss guarantee for arbitrary pending writes.
- With the workspace disk absent, runtime, Docker, containerd, and the Docker
  socket remain inactive; `/workspace` stays empty and no environment is written.
  The device job expires after 90 seconds. SSH also waits for local filesystem
  initialization, so serial-console evidence matters for diagnosing this case.

## Image size and build evidence

Base: `debian-12-bookworm-v20260902`; Node 24.6.0; Rust bootstrap 1.29.0;
Docker 29.1.3; containerd 2.3.4; agent-browser 0.33.2. Core binary downloads are
checksum-verified. Other APT versions are recorded, not fully locked. This is not
yet a reproducible production release pipeline.

Timed clean installation: 91 seconds (`build-d.log`, 17:05:07–17:06:38 UTC),
excluding builder provisioning, sealing, stopping, and image capture. An earlier
clean installation took 85 seconds. Initial runtime start to ready took about
22 seconds, including the first persistent Rust toolchain download. Later broker
readiness is affected by the manually reconnected SSH tunnel; these samples are
not a production cold-start or release-latency benchmark.

Candidate D was built cleanly; final image E applies the audited boot/configuration
fixes and browser pruning to the earlier clean builder. E's 563 package/version
entries match D exactly, and installed bootstrap/service hashes match the recipe.
The replacement checks run on E.

Image E's compressed archive is about 1.30 GiB (1,392,340,416 bytes).

The final package inventory contains 563 packages, including Debian's guest
baseline and transitive libraries. The image uses about 3.7 GiB; `/app` is about
356 MiB. Large required components include gcloud (404 MiB installed package
size), Chromium (275 MiB), Google's guest agent (200 MiB), the kernel, Docker,
containerd, and native compilers. APT recommendations, package caches, OS Config,
unattended upgrades, and approximately 75 MiB of browser executables for other
platforms are excluded. The Debian guest baseline still includes utilities such as Vim/nano and wget;
the production package allowlist work is tracked in `TODO.md`. This is a measured
baseline, not proof of the smallest possible Debian image. Package purposes are in `infra/native-vm/PACKAGES.md`.

Size follow-up (2026-09-05): the 3.7 GiB figure is installed filesystem use,
not RAM or the compressed image. The measured direct-package totals are 404 MiB
for gcloud, 339 MiB for Chromium/common (before supporting libraries), and
319 MiB for Docker/CLI/containerd/Buildx/Compose. `/app` adds 356 MiB; the guest
agent and kernel add about 303 MiB. Obvious inherited utilities (Vim variants,
nano, wget, manual pages and optional APT utilities) account for about 53 MiB
before dependency changes. Removing those alone cannot save gigabytes.

An approximately 3 GiB installed image is an unvalidated optimization target,
not a measured minimum or a new requirement. A smaller Debian package selection,
asset/dependency audit, and boot/tool acceptance would establish the actual floor.
Preserve the required [GCE guest environment](https://docs.cloud.google.com/compute/docs/images/guest-environment).
Moving required tools into first-boot downloads merely shifts bytes into persistent
state and startup work; it does not establish a smaller total environment. The
experiment supports proceeding with native VMs. Its substantive remaining risks
were container access to VM identity and integration with actual production
replacement/reconciliation. The follow-up below tests those paths. Docker store
handling on engine updates is deferred until such an update is undertaken.
The work and policy choices remain in `TODO.md` and `docs/open-questions.md`.

The fixture consumes roughly 39 MiB in Docker metadata/volumes, 626 MiB in
containerd, and 1.47 GiB in home (mostly the persistent Rust toolchain). These are
used bytes; billing follows allocated disks, not those measurements.

## Failures retained and corrected

1. Malformed Tailscale APT source prevented installation. Corrected the distribution
   field and rebuilt. Evidence: `failure-001-build.log`.
2. Concurrent manual/scripted submissions produced a rejected request. The original
   rejection reason was not captured; it cannot be attributed more precisely.
   Subsequent submissions are serialized, wait for idle, and record the result.
   Evidence: `failure-002-overlapping-check.log`.
3. Non-root Tailscale could not create `/var/run/tailscale`. A systemd
   `RuntimeDirectory` supplies the writable directory. Evidence:
   `failure-003-tailscale-directory.log`.
4. Tailscale's executable was outside the service PATH. Include the system sbin
   directories. Evidence: `failure-004-tailscaled-path.log`.
5. Concurrent naming consumed a sequential mock-model rule intended for the tool
   continuation. Separate model/naming sessions and explicit summary rules fix
   the harness scheduling error. Evidence: `failure-005-mock-routing.log` and the
   mock request ledger `fake-requests.json`.
6. Admission raced local control-plane startup. Wait for its HTTP readiness before
   creating fixtures. Evidence: `failure-006-admission-before-listen.log`.
7. `npm ci --ignore-scripts` left the browser binary non-executable; the unprivileged
   runtime could not chmod its root-owned installation. Set permissions during
   image construction. Evidence: `failure-007-browser-permissions.log`.
8. The fixed adapter rejected the normal 15-minute idle stop. Keeping a tab visible
   was insufficient after a long control-plane pause: persisted activity was stale
   on restart. Disable idle auto-stop in the isolated test process; stop it during
   deliberate VM downtime. Production is unchanged. Evidence:
   `failure-008-idle-stop.log` and `failure-010-idle-on-cp-resume.log`.
9. A quote-sensitive edit silently left containerd's root on the boot disk. Its
   generated TOML uses single quotes. Replace the complete root assignment and
   parse/assert the resulting TOML. Detected before discarding compute; stopped
   both daemons, copied the store with ownership preserved, then verified it before
   repeating lifecycle checks. Evidence: `failure-009-containerd-root.log`,
   `containerd-correction-a.log`, and `stop-start-corrected-a.log`.

10. The repeated protocol check mistook a replayed final history record for the
    new turn completing, then asserted before the new tool event arrived. Scope
    assertions to frames after submission and persist frames on exit. Evidence:
    `failure-011-history-replay-check.log` and
    `replacement-protocol-corrected.log`.

11. Cleanup reached an empty optional shell array unsupported by macOS Bash 3.2
    with `set -u`. Keep the required project argument in every scope array. All
    VMs/disks had already been removed; the corrected script resumes with images
    and verifies empty inventories. Evidence: `failure-012-cleanup-shell.log`.

IAP lookup/SSH connection probes also encounter normal provisioning delays.
Readiness probes retain those failures and distinguish them from acceptance
assertions. Sealing deliberately removes host keys; reconnecting a restarted
builder requires refreshing only that experiment instance's known-host entry.

## Initial run: production boundary

The ordinary local E2E suite passed: 39 tests in four files, 695.51 seconds. Those
tests complement the actual-VM checks; they do not replace them.

No production provider, deployment, IAM policy, network, or orb is changed. This
run does not establish live GitHub/cloud federation, service-account isolation
from project containers, arbitrary Docker upgrades/downgrades, Testcontainers,
Spot handling, fleet concurrency, disk-full recovery, or automated release and
rollback. Journals are exported before deletion; there is no Cloud Logging shipper
in this prototype. Production needs durable queryable diagnostics and user-visible
failure reporting before it ships. Remaining work lives in `TODO.md`; policy
choices remain in `docs/open-questions.md`.

## Initial run: completion and cleanup

All stated acceptance cases above passed after the documented corrections.
Formatting, E2E TypeScript checking, shell syntax, and Python compilation checks
also pass. Experiment VMs, disks, and all five candidate images are deleted;
post-cleanup GCP inventories are empty. The experiment's Tailscale identity/key
and three mock sessions are removed, and local control-plane/tunnel/browser
sessions are stopped. Recipes and local evidence remain. Cleanup evidence:
`cloud-cleanup-final.log`, `cleanup-*-after.json`, `tailscale-cleanup.log`, and
`fake-cleanup.log` under `.context/native-vm/`.

## Production integration follow-up — 2026-09-05

Decision: Docker, its socket, and containerd are disabled at boot. An agent can
start Docker with `sudo systemctl start docker`; runtime readiness does not depend
on it. UID/GID 2000 with passwordless sudo remains the tested tool environment.
The user will archive active orbs before deployment; no active-orb migration or
compatibility layer is required. Engine/store upgrade policy is deferred until an
engine update is undertaken.

This run uses the production GCE provider and reconciler in an isolated control
plane on the existing Cloud Run egress subnet. Its VM uses the existing control-plane
service account; orbs use the existing orb VM account, subnet and runtime firewall.
A test-only Compute transport substitutes the native image/startup metadata and
translates ownership labels into a separate experiment namespace. Every request
is restricted to the disposable orb. Private control-plane/runtime/broker traffic
uses the VPC; SSH tunnels provide only local UI and diagnostic access.

The control-plane database, broker secret storage and model/OAuth fixtures are
isolated. GitHub uses the logged-in user's existing credential without testing the
OAuth authorization ceremony. GCP federation uses a temporary public JWKS issuer,
matching the test control plane's signing key, and a pool restricted to this
orb/project. Its service account has only `roles/browser`. The production Cloud
Run service and existing orbs are not deployed or modified.

Evidence is under `.context/native-vm-integration/`; the composition and probes
are in `e2e/native-vm/integration/`. The copied replacement image has identical
software under a different image resource name: it tests selection, fingerprint
and lifecycle behavior, not an engine upgrade.

### Findings established before replacement

- Provisioning required `compute.images.useReadOnly` on the private custom image.
  Granting `roles/compute.imageUser` on that image let the normal retry succeed.
  Production image publication must supply the corresponding permission.
- An orb reached ready with Docker/service/socket/containerd disabled and inactive.
  `docker info` did not activate them. The normal agent tool explicitly started
  Docker, ran an Alpine container and delivered its result through the runtime
  WebSocket proxy. The terminal PTY also passed.
- Live GitHub `gh api user`, initial repository clone, and project-secret delivery
  passed. Secret storage here is the file adapter, not production Secret Manager.
- Testcontainers 12.1.0 passed with its Ryuk cleanup service and a mapped HTTP port.
- The native identity helper passed real STS exchange, service-account
  impersonation and a read-only project API call. STS rejected a wrong audience.
  A stopped orb's bearer returned `403 not_mintable`.
- The VM metadata identity was denied Compute listing, Secret Manager listing,
  and service-account impersonation. Its existing roles are Artifact Registry
  reader and Logging writer; this experiment does not revoke production grants.
- Explicit Stop drained history and stopped the VM. Start reused the VM and
  session; Docker remained disabled and inactive after reboot.
- Startup events written by the test launch adapter were queryable in Cloud
  Logging. This is not a complete production guest-log pipeline.

### Integration failures and corrections

- Missing private-image permission: retained in
  `compute-first-image-denial.jsonl`; corrected on the test image only.
- The production orphan sweeper saw the initial test VM's production ownership
  label and stopped it. Audit logs identify the production service account;
  the isolated reconciler restarted it. Separate test ownership labels fix
  this harness isolation defect. The interrupted protocol test's frames remain
  in `protocol-frames-orphan-interference.json`; the isolated check passed.
- Docker Desktop's credential helper hung during local image builds. The first
  E2E evidence remains in `e2e.log`. A task-local Docker client configuration
  omits that helper; image builds then succeeded without changing user settings.
- The first Testcontainers fixture used Alpine without an `httpd` executable.
  Container debug logs show `httpd: not found`; switching the fixture to BusyBox
  fixes the fixture. Port waits and assertions were not relaxed.
- A control-plane restart overlapped a retention terminal probe and closed its
  WebSocket. Serialize lifecycle actions after probe completion; the terminal
  driver now persists output incrementally and fails on premature closure.
- A retention probe was copied to `/tmp`, which Debian clears on reboot.
  Keep acceptance scripts on the persistent test workspace. This was probe
  placement, not workload-data loss; retain the failed probe output. An initial
  copy attempt during VM boot also failed before SSH was available; wait for
  successful copy/install completion before invoking a probe.

### Lifecycle and regression evidence

The local E2E suite passed 39 tests in four files in 659.53 seconds using the
isolated Docker client configuration. The selected GCE provider, deterministic
replacement and workload-identity tests passed 78 tests in four files. E2E
TypeScript checking passed.

GCE's `simulate-maintenance-event` stopped the Spot VM; the real reconciler
observed the stopped host, started the same incarnation, and reached ready.
The session remained `01a072be-b7ce-757b-a758-8dcdeee0c261`; Docker was still off.
After explicit Docker start, the checkpointed PostgreSQL record, unpublished image
ID, stopped-container writes, unattached volume and workspace sentinel passed
retention checks across the combined Stop/Start and Spot interruption sequence.
A project container could read the orb VM service-account email from metadata;
this is the same identity tested above, not a separate security boundary.

Changing the configured image and generation while the orb ran left instance
`7604050450231453544`, incarnation 0, running. The replacement image is a copy of
the tested image, with its own image resource and use permission.

Explicit Stop/Start replaced incarnation 0 with incarnation 1. GCE reports the
new boot disk's source as the selected replacement image. The original session,
repository, checkpointed PostgreSQL record, Docker image/container/volume state
and workspace sentinel survived. Docker was off before explicit startup.
The old incarnation's bearer returned `401 unauthorized`; incarnation 1 passed
fresh STS/impersonation, wrong-audience rejection, the VM identity denial checks,
and the normal agent tool/PTY protocol. Startup events from the deleted
incarnation remained queryable in Cloud Logging.

The first deliberate launch-failure attempt wrote its marker under the repository
instead of the runtime workspace root. No failure was injected; the normal
restart passed. Moved the probe to `/workspace/.native-integration-fail` and restarted the
runtime service. This injected runtime initialization failure on an already
running orb; the reconciler exercised its unreachable-runtime restart path. The marker selects only incarnation 1.

The corrected initialization fault caused one unreachable-runtime restart. The
next boot reported the same incarnation-scoped failure; the control plane
persisted `runtime_failed: e2e_launch_failure`, displayed it in the browser,
and discarded incarnation 1 plus its boot disk. The workspace disk remained
detached. The orb stayed failed until explicit Start. The startup marker was
included in stored host evidence, and its Cloud Logging records remained
queryable after deletion. Detailed early systemd/guest failures still need the
production diagnostic pipeline; this injected failure came through the runtime's
structured health response.

Explicit Start created incarnation 2. It reached ready with Docker off and the
original session. After explicit Docker startup, all retained workload assertions
passed again. The userspace Tailscale preview served the expected fixture from
the VM to the Mac. No production deployment was performed.

### Remaining production work

The experiment establishes the tested architecture and production lifecycle paths.
It does not ship the native launch adapter or foundation/release integration.
The package allowlist, release input locking, final image publication/use grants,
native early-boot diagnostics and disk-full acceptance remain in `TODO.md`.
This run did not exercise the production PostgreSQL/Secret Manager composition,
the GitHub OAuth ceremony, fleet concurrency or Docker engine changes. Existing
credential/release gates retain their own scopes; this test issuer does not claim
to validate the deployed production issuer.

### Follow-up cleanup

All experiment VMs, boot/workspace disks, images, firewall rules, the temporary
issuer service/container image, and the test service account/grants are removed.
The WIF pool/provider are soft-deleted and inactive. GCP inventories and project
IAM checks confirm no remaining owned compute or account grants. The fixture
project/orb return 404; Tailscale cleanup and both mock-session deletions passed.
Local browser/tunnels are stopped; temporary GitHub/Tailscale credential copies
and the old bearer are deleted. Recipes and credential-free evidence remain.

Cleanup evidence: `project-cleanup.log`, `cloud-cleanup.log`,
`auxiliary-cleanup.log`, `cleanup-*-after.json`, `cleanup-wif-state.txt`,
`tailscale-cleanup.log`, and `mock-cleanup.log` under
`.context/native-vm-integration/`.

## Production implementation validation — 2026-09-05

The native GCE provider, guest recipe, image builder, foundation state split and
release composition are implemented. These runs use the same project/zone,
with an isolated control plane and separately labelled disposable resources.
Production remains unchanged. Evidence is under `.context/native-vm-production/`.

The documented `npm run native-image:build -- …` command produced accepted
images from independent source snapshots. The final validation build ran from
21:39:28 to 21:47:58 UTC (8 minutes 29 seconds), including provisioning,
installation, sealing, image capture, fresh-VM acceptance, Cloud Logging
verification and temporary-resource cleanup. Its image ID was
`8725839102709150264`; the compressed archive was 1,366,227,328 bytes (1.27 GiB).
The source was dirty and its exact archive/file hashes were recorded; releases
require a clean commit. These are experiment artifacts, not deployed releases.

The production provider verified the exact image ID and created a Spot orb with
a fresh 50 GiB `pd-balanced` workspace. Its first attempt exposed a real deadline
mismatch: the control plane persisted `runtime_never_answered` after 181 seconds
while the guest was still checking the blank disk, then discarded only compute.
The measured full-device check on explicit recovery took 336 seconds
(21:39:11–21:44:47 UTC). GCE now grants twelve minutes for first runtime contact,
above the guest's ten-minute workspace-unit bound and below the fifteen-minute
create/start deadline. Existing ext4 disks skip the scan. The recovered orb
reached ready with Docker, its socket and containerd disabled, then passed the
normal WebSocket/agent-tool/PTY checks; the agent started Docker explicitly.

The build experiments also exposed and corrected API response-shape assumptions,
retry classification for interrupted IAP SSH, and an incomplete validation broker.
The final broker has real HTTP/schema tests. Source snapshots now use one Git
file list for archive and hashes, exclude ignored files and macOS metadata, and
reject symlinks. The disposable control plane's initial migration failed because
an earlier archive carried AppleDouble SQL sidecars; the corrected archive uses
`--no-xattrs`, and first-failure evidence remains preserved.

Guest diagnostics publish exact boot errors to guest attributes and Cloud Logging.
A real nonblank-disk fault exposed a generic systemd diagnostic overwriting the
specific error; the final image preserves that exact error while publishing the
unit/journal evidence separately. Workspace capacity is reported only after the
workspace is mounted.

The complete test run passed 1,044 unit/DST tests and 25 guest tests. Foundation
coverage subsequently passed eleven tests; the browser/runtime E2E suite passed all
39 tests. The foundation adoption driver projected sixteen existing resources
into separate state and retained thirty-three in application state, with resource
identities preserved. This was read-only: adoption and infrastructure apply were
not executed. Exact scoped deployer permissions and the deployed PostgreSQL/
Secret Manager release composition remain deployment gates in `TODO.md`.

Live storage-fault acceptance used a nonzero byte in the middle of an otherwise
blank disk. The entire device SHA-256 matched before and after boot, with no
filesystem created. Filling a mounted workspace to zero available bytes caused
an orb-user write to fail while approximately 16 GB remained free on the boot
disk; removing the filler restored space and preserved both a workspace marker
and Docker named-volume marker. A second 50 GiB initialization took 363 seconds.

The production orb also passed broker-backed `gh api user`, a fresh GitHub clone,
project-secret delivery and Testcontainers mapped-port HTTP. Its seeded retention
fixture includes an unpublished image, stopped-container writes, an unattached
volume, a bind mount and a checkpointed Compose PostgreSQL record. The identity
fixture initially retained its old provider in the running guest's boot-time
secret snapshot; that error was diagnosed before retrying and the corrected
provider is loaded through normal Stop/Start.

The final image passed both missing-disk and nonblank-disk checks with exact
errors in guest attributes and Cloud Logging. The disk-full fixture also remounted
successfully after reboot, with Docker off and both markers retained after
explicit Docker startup. Its runtime separately reported
`rust_toolchain_init_failed` when `static.rust-lang.org` timed out; the disk checks
therefore establish filesystem/Docker recovery, not runtime readiness under that
network failure. The production-provider orb completed Rust initialization and
its runtime checks. Fault evidence and cleanup inventories are in
`.context/native-vm-production/faults/SUMMARY.md`.

The production orb passed real STS federation and service-account impersonation,
wrong-audience rejection, and denial of Compute/Secret Manager/impersonation
requests using the VM identity. Stop/Start retained all seeded workloads. A real
Spot maintenance event moved the orb through recovery back to running; Docker
remained off until requested, and all retention assertions passed again.

Changing the control plane to the final image left the running VM untouched for
multiple reconciliation passes. Stop/Start then created incarnation 2; the boot
disk's `sourceImageId` matched the accepted manifest exactly. Its original
session, all workload markers, fresh federation and WebSocket/tool/PTY checks
passed. The previous bearer returned HTTP 401 `unauthorized`. An initial probe
expected a different error name; the production protocol already specifies
`unauthorized`, and both the original response and corrected assertion are saved.

An incarnation-bound runtime fault then persisted `runtime_failed:
e2e_launch_failure` with host evidence, logged the lifecycle failure/discard
edges, and deleted incarnation 2. Its exact guest error remained queryable in
Cloud Logging afterwards. Explicit Start created incarnation 3 and reached ready
using the retained workspace.

Incarnation 3 passed retention and fresh federation again. All disposable orb,
control-plane, builder and fault VMs/disks, accepted experiment images, temporary
firewalls, issuer/artifact resources and service-account grants are deleted. The
WIF pool is soft-deleted and inactive. Project/orb API deletion, Tailscale cleanup
and both mock-session deletions passed. Final GCP inventories are empty for the
owned scopes; the IAP tunnel exited, and temporary credential copies were removed.
Recipes, manifests and credential-free evidence remain. No production deployment
or remote-state adoption was performed.
