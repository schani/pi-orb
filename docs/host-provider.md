# Orb host provider

How orb compute is provisioned: the `OrbHostProvider` port, incarnations and immutable host specifications, runtime readiness, the runtime image, and the process, Docker and GCE providers. The lifecycle state machine that drives these operations is `docs/lifecycle.md`; deletion-grade cleanup is `docs/teardown.md`.

## Agent placement

Pi runs centrally in the control plane with PostgreSQL authority; its hosts run execution services only (`PI_ORB_RUNTIME_MODE=execution`). Claude runs natively on its host with filesystem resume authority (`PI_ORB_RUNTIME_MODE=claude`). Process, Docker and GCE derive the mode from the stored harness (`pi`/`claude`) passed in provision bootstrap and desired-spec input; provider-owned selection overrides `extraEnv`. The effective harness participates in the spec fingerprint. No model bearer enters launch specifications, provider metadata, fingerprints or public orb views.

Initial Git contents, manifest and exact SHA for central Pi persist in PostgreSQL; the control plane fetches the repository's default branch (`HEAD`), and a failed Git command logs `resources.failed code=fetch reason=<missing_ref|authentication|repository_not_found|network|unknown>`. Central Pi provisioning always sets `awaitInitialCheckoutCommit`, even when the SHA is known. A fresh checkout polls `GET /api/runtime/initial-checkout` (bearer plus exact `x-orb-incarnation`) within the 20-minute deadline: `200 {commitSha}`, `202 {pending:true}`, `409 {error:checkout_admission_revoked}`, `503 {error:resource_acquisition_failed|unavailable}`. Acquisition failure is terminal and `unavailable` retryable. An initial `401` may precede the provider's bearer CAS and is retryable only until the first authenticated response; after an authenticated `202`, `401` is terminal; `403` and `409` are always fatal. It then checks out that SHA and runs the normal hooks. Retained workspaces bypass the endpoint, and resume never resets dirty files. Pending acquisition is excluded from fingerprint churn; allocation and fetching run concurrently.

## The `OrbHostProvider` port

The control plane and lifecycle depend only on this port (`apps/control-plane/src/domain/ports.ts`). No control-plane service or HTTP handler invokes Docker, GCE or processes directly. Providers manage infrastructure only: no knowledge of Pi, Claude, conversations, prompts or history.

```ts
type OrbHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

interface OrbHostProviderError {
  type: "orb_host_provider_error";
  provider: string;
  operation: "provision" | "start" | "stop" | "discard" | "destroy" | "observe" | "list";
  code: "unavailable" | "conflict" | "invalid_state" | "operation_failed" | "cancelled";
  message: string;
  retryable: boolean;
}

interface OperationContext { signal: AbortSignal } // in-process only

interface OrbHostRef { provider: string; resourceId: string }

interface OrbHostObservation {
  ref: OrbHostRef;
  orbId: string;
  incarnation: number;              // unstamped legacy compute reads as 0
  specFingerprint: string | null;   // legacy compute reports null
  state: OrbHostState;
  lastStartedAt?: number;           // epoch ms of the last entry into running
  runtimeAddress?: { baseUrl: string }; // ephemeral; never persisted authority
  failure?: { code: string; message: string };
}

interface ProvisionOrbHostRequest {
  orbId: string;
  incarnation: number;
  claudeRecoveryProof?: ClaudeRecoveryProof;
  bootstrap: {
    repositoryUrl: string | null;
    harness?: "pi" | "claude";
    initialCheckoutCommit?: string;
    awaitInitialCheckoutCommit?: boolean;
  };
}

interface StartOrbHostRequest {
  ref: OrbHostRef;
  expectedIncarnation: number;
  expectedSpecFingerprint: string | null; // null matches only unstamped legacy compute
}

interface ProvisionedOrbHost {
  ref: OrbHostRef;
  incarnation: number;
  runtimeTokenHash: string; // SHA-256 of the token the host actually carries
  specFingerprint: string;
  specGeneration: number;
}

interface OrbHostProvider {
  readonly kind: string;
  readonly specGeneration: number;
  readonly verifiesWholeComputeDisposal?: true;
  desiredSpecFingerprint(input: {
    orbId: string;
    repositoryUrl: string | null;
    harness?: "pi" | "claude";
  }): string;
  provision(task: SimulationTask, request: ProvisionOrbHostRequest, context: OperationContext): ResultAsync<ProvisionedOrbHost, OrbHostProviderError>;
  start(task: SimulationTask, request: StartOrbHostRequest, context: OperationContext): ResultAsync<void, OrbHostProviderError>;
  stop(task: SimulationTask, ref: OrbHostRef, context: OperationContext): ResultAsync<void, OrbHostProviderError>;
  discardCompute(task: SimulationTask, request: { orbId: string; throughIncarnation: number }, context: OperationContext): ResultAsync<void, OrbHostProviderError>;
  destroy(task: SimulationTask, orbId: string, context: OperationContext): ResultAsync<void, OrbHostProviderError>;
  observe(task: SimulationTask, ref: OrbHostRef, context: OperationContext): ResultAsync<OrbHostObservation | null, OrbHostProviderError>;
  listManagedHosts(task: SimulationTask, context: OperationContext): ResultAsync<OrbHostObservation[], OrbHostProviderError>;
  executionBinding?(task: SimulationTask, ref: OrbHostRef, context: OperationContext): ResultAsync<{ baseUrl: string; token: string; incarnation: string; cwd: string }, OrbHostProviderError>;
  diagnose?(task: SimulationTask, ref: OrbHostRef, context: OperationContext): ResultAsync<string | null, OrbHostProviderError>;
}
```

- `provision` is idempotent by orb ID and incarnation: it creates and starts the host or returns the matching existing one. Resolving means infrastructure is running, not that the runtime is ready. `runtimeTokenHash` is minted for a new host and read back from the delivery channel for an existing one; lifecycle commits it next to the host ref (`docs/credentials.md`).
- `start` is idempotent and refuses a resource with a different incarnation or spec stamp (typed `conflict`), checked before any state change.
- `stop` gracefully stops compute and keeps its filesystem.
- `discardCompute` removes every exact-orb compute incarnation at or below `throughIncarnation` and preserves authoritative storage. It resolves only on verified absence; uncertainty is an error.
- `destroy` is deletion-grade: it enumerates every exact-orb incarnation, including legacy unstamped names, then removes authoritative storage. It addresses resources by orb identity so cleanup works when `host_ref` was lost (`docs/teardown.md`).
- `observe` returns `null` only on definitive absence; provider or transport uncertainty is `Err`. There is no `unknown` or `missing` state.
- `listManagedHosts` serves reconciliation and the orphan sweep.
- `diagnose` returns bounded host-side evidence (GCE guest attributes) for boot failure and diagnosis-before-discard.
- `verifiesWholeComputeDisposal` means verified disposal ends the entire worker scope. Docker and GCE advertise it; the process provider does not (it verifies recorded process groups, not escaped descendants). Only advertising providers can authorize automatic Claude uncertain-worker replacement (`docs/lifecycle.md`).

Every call takes an `OperationContext`; the provider passes its signal to the underlying API and returns typed `cancelled` once cancellation is observed. Cancellation does not roll back external side effects; ambiguous outcomes are resolved by later idempotent `observe` and reconciliation.

The port deliberately omits `restart` (lifecycle composes stop/start), `exec` (runtime protocol), per-orb machine/OS/image configuration, harness operations, and runtime health or busy state. Infrastructure and credential-delivery settings belong to provider construction (`DockerOrbHostProviderOptions`, `GceOrbHostProviderOptions`, `ProcessOrbHostProviderOptions`).

### Claude recovery launch proof

`ProvisionOrbHostRequest.claudeRecoveryProof` is `{ episode, disposedIncarnation, replacementIncarnation }`. Lifecycle supplies it only from finalized, verified disposal for the current replacement incarnation. Providers reserve `PI_ORB_CLAUDE_RECOVERY_PROOF` and override inherited or configured values; project secrets and the hook env file cannot override it. The runtime validates the bounded proof before applying hooks or environment. It is boot authority, not desired-spec configuration.

## Incarnations and immutable host specifications

A compute incarnation is disposable process/container/VM state; the workspace is not. Compute is never repaired in place. The replacement rules and their lifecycle ordering are in `docs/lifecycle.md`; this section is the provider half.

| Provider | Compute (incarnation-specific) | Authoritative storage (fixed) |
| --- | --- | --- |
| GCE | instance `pi-orb-<orbId>-i<n>` plus its auto-delete boot disk and ephemeral NIC/IP | data disk `pi-orb-data-<orbId>` (`autoDelete: false`) |
| Docker | container `pi-orb-<orbId>-i<n>` | volume `pi-orb-data-<orbId>` |
| Process | runtime process group and incarnation metadata/log handles | per-orb workspace directory |

The legacy un-suffixed name `pi-orb-<orbId>` reads as incarnation 0. Incarnation-specific names prevent a delayed delete-by-name from reaching a replacement. All names keep the `pi-orb-` prefix that IAM conditions scope compute mutations to (`infra/foundation/iam.tf`). Observations report the actual inspected resource name, never a reconstructed one. No cleanup path deletes by substring, by stale `host_ref` alone, or without exact ownership and incarnation checks.

**Spec fingerprints.** `desiredSpecFingerprint({ orbId, repositoryUrl, harness })` is pure and goes through one canonical helper (`apps/control-plane/src/adapters/spec-fingerprint.ts`: recursively key-sorted JSON, SHA-256), so revisions building the same effective spec cannot disagree. It is rendered at incarnation 0: rotating an incarnation is not a spec change.

- GCE hashes the single `launchSpec` that also builds the insert body: runtime image resource and numeric ID, per-instance runtime configuration, boot disk size, machine type, subnetwork, service account and scopes, scheduling and data-disk size. A host cannot carry a setting the fingerprint does not cover.
- Zone and project ID are excluded. The data disk is zonal; a replacement in another zone would come up on an empty workspace. A zone or project move is an explicit operator migration.
- Process includes its configured command directory.

**The stamp lives on the compute:** GCE metadata `pi-orb-host-spec-fingerprint`, Docker label `pi-orb.host-spec-fingerprint`, process `specFingerprint` in `host.json`. Provision-reuse and `start` verify incarnation and stamp before any state change and return `conflict` on mismatch; a stale-spec incarnation is never started, resurrected or rewritten.

**Deploy generation.** `PI_ORB_HOST_SPEC_GENERATION` (infrastructure `-var deploy_generation=$(date +%s)`, clamped monotonic by `infra/release.sh`) reaches each adapter as `specGeneration` and is committed with the fingerprint as the orb's `host_spec_generation`. It fences the replacement decision forward-only (`docs/lifecycle.md`).

**Image pinning.** GCE composition requires `PI_ORB_GCE_IMAGE_RESOURCE` (an exact `projects/.../global/images/...`, never a family) and `PI_ORB_GCE_IMAGE_ID`, plus the workspace template resource and ID. The provider reads each image and rejects an ID mismatch before any disk or instance mutation, so name reuse or a moving alias cannot change host contents invisibly. Local Docker image selection is independent.

**Provider disposal mappings.**

- GCE `discardCompute` lists by exact orb ownership, deletes matching instances at or below the fence (including the legacy name), waits for each operation and verifies absence. It never deletes the data disk. `destroy` additionally deletes and waits for the data disk, tolerating an already-deleted boot disk.
- Docker force-removes matching containers; `destroy` removes the container before the volume. Shared images and networks are never removed.
- Process persists the launched process-group leader and supervisor birth identity in host metadata, so a replacement control-plane process can verify and terminate compute it did not launch. Discard terminates the recorded group and removes only ephemeral launch metadata. `destroy` also removes the host directory recursively without following symlinks out of it.

## Runtime readiness

Provider state and runtime readiness are separate. `provision`/`start` success means compute is running; an orb becomes `running` only after the control plane receives a ready health response and persists its identity, session and commit data.

The runtime starts its health server before slow initialization, so `GET /v1/health` answers with a typed `initializing`, `ready` or `failed` body whenever the process can serve HTTP (payload: `docs/runtime-protocol.md`). The control plane interprets the discriminant, not status codes. Network failure is distinct from any returned status. Central Pi execution readiness uses `/execution/ready` and needs no model authority on the host.

Native Claude is ready when the runtime identity matches the orb; the retained workspace exists and any configured checkout is valid; the session is created or loaded from the filesystem; the harness credential resolves; history-pull and WebSocket handlers are installed; and an idle runtime can accept a message.

**Boot order.** Establish persistent `$HOME` and Rust state paths, check out the repository, run `.agents/setup`, fetch project secrets, run `.agents/resume`, merge the hook env file, then load the session (`docs/orb-setup-hook.md`). The runtime does no Rustup network or toolchain work.

**Session identity.** The runtime never replaces an existing session. If a session exists on the filesystem it must load; a load failure is non-retryable `session_load_failed`, never grounds for a fresh session. A new session is created only when none exists. A session-header mismatch during replication therefore means a bug or corruption (`docs/history.md`).

**Checkout.** A fresh clone goes to a temporary directory and is atomically renamed into place; restart reuses a complete checkout and cleans or retries an incomplete temporary clone. A repository without commits is valid: when the checkout has no refs, `checkoutCommit` is null. Refs with an unresolvable HEAD fail `clone_failed`.

**Repository-free projects.** `repositoryUrl: null` creates the retained `<work-dir>/repo` without `git init`, clone, pin admission or HEAD inspection, and reports `checkoutCommit: null`, even if the user later creates a repository there. The URL selects only fresh-workspace clones: attaching one to an existing non-Git workspace changes nothing; removing one keeps existing Git files. Corrupt Git metadata still fails boot when a URL is configured. Providers encode null as an empty `PI_ORB_REPOSITORY_URL`; runtimes also accept it absent. Creation failure is `workspace_init_failed`.

**Failures.** Expected initialization failures (clone, invalid repository, unusable credentials) are reported as `failed` long enough for the control plane to record them. A runtime that owns bounded recovery stays `initializing` while retrying. Unexpected process failure exits the process and is handled by provider supervision (Docker restart policy, systemd on GCE, the Python supervisor for process hosts); an explicit provider `stop` reconciles that supervision to stopped.

**Restart context.** Docker images and native VMs set `PI_ORB_CONTAINER=1` (PID 1 defines the guest's lifetime). The runtime combines `/proc/sys/kernel/random/boot_id` with PID 1's start time from `/proc/1/stat` to identify the execution lifetime; the kernel UUID alone misses retained-container stop/start. The process provider forces `PI_ORB_CONTAINER=0`, so even a containerized control plane cannot claim container-wide lifetime for unsandboxed children. Each supervisor lifetime supplies a fresh `PI_ORB_SUPERVISOR_ID`, stable across runtime-child restarts. The process provider persists its own `supervisorId` in host metadata, keeps it through crash relaunch and provider recovery, and rotates it when explicit Start/provision moves desired state from stopped to running. These feed the idle-stop admission fence and restart wording (`docs/lifecycle.md`).

## Shared runtime environment

The shared contract is a persistent filesystem plus a host running the orb runtime with provider-delivered environment variables, including the broker URL/bearer pair (`docs/credentials.md`). Project secrets arrive through the broker. Packaging never enters lifecycle.

**Runtime user.** Docker runs the runtime as root (the image has no `USER`). Native GCE runs it as `orb` (UID/GID 2000) with passwordless sudo and `docker` group membership. Process hosts run as the developer's user. `sudo` is in both images so repository hooks using `sudo apt-get` work; as root it elevates nothing. The `orb` user is a tool-behavior choice, not an isolation boundary: Docker group membership already grants root ([Docker docs](https://docs.docker.com/engine/install/linux-postinstall/)).

**Persistent home.** Every provider sets `HOME=<work-dir>/home` (`/workspace/home` on Docker/GCE). The runtime creates it with mode `0700`, repairs permissions every boot, resets `HOME` to that path, and fails readiness with `home_init_failed` if it cannot. Anything following `$HOME`/`os.homedir()` therefore lands on the retained orb filesystem with the repository, native Claude history and guest credential cache. Docker's writable layer and the GCE boot disk stay disposable. On every boot, after establishing `$HOME`, the runtime sets `RUSTUP_HOME`/`CARGO_HOME` under it and prepends `$CARGO_HOME/bin` to `PATH`.

**Skills.** Images bake bundled platform skills at `/opt/pi-orb/skills`, outside the workspace. Providers set `PI_ORB_SKILLS_DIR`; the runtime never guesses a path. Central Pi acquires its own resources (`docs/pi.md`).

## Runtime image baseline

Docker (`apps/orb-runtime/Dockerfile`) and native Debian (`infra/native-vm/install.sh`) images carry the same prescribed tools. No installation runs at orb boot; no keys or credentials are baked in.

- Node.js 26.13.0 LTS and npm 12.2.1; git, ripgrep, curl, `zip`/`unzip`, `sudo`.
- Python 3 with the `python` alias and `venv`. No global `python3-pip`: Debian's externally-managed policy favors `python -m venv .venv`.
- `build-essential`, `pkg-config`, `libssl-dev` for native addons. `node-pty` is rebuilt from source during image construction (`docs/terminal.md`).
- Rustup 1.29.3 (SHA-256-verified per architecture) and its proxies, with **no toolchain**. Users, hooks or `rust-toolchain.toml` acquire toolchains, which persist in `$HOME`. Rejected: automatic stable installation, which made boot depend on `static.rust-lang.org` (`docs/postmortems/2026-09-07-native-rust-dns-bootstrap.md`).
- Bun 1.4.4 (`bun`, `bunx`) from SHA-256-pinned official archives (`infra/install_bun.sh`): x64 baseline build (no AVX2 requirement) and aarch64.
- git-crypt 0.8.0, built from pinned upstream source by `infra/install_git_crypt.sh` with commit and archive SHA-256 checked before build. Debian ships 0.7.0 and the upstream binary needs GLIBC 2.38. The checksum is locally measured over HTTPS, not an upstream signature. `COPYING` and the unmodified source archive are installed under `/usr/local/share/doc/git-crypt/`.
- `agent-browser` 0.41.2 (pinned runtime dependency, CLI on `PATH`) with Debian Chromium. The native image marks its packaged Linux x64 binary executable after the scripts-disabled install; the unprivileged runtime cannot chmod a root-owned file.
- `gh` and `google-cloud-cli` (base package only: `gcloud`, `gsutil`, `bq`; about 0.66 GB, accepted so agents can operate GCP projects). Both apt repositories use armored keyrings with `signed-by`.
- Shims in `/usr/local/bin`: `gh` and `pi-orb-git-credential` for broker-backed GitHub auth (`docs/credentials.md`); the `pi-orb` POSIX dispatcher, which execs the Node entry point for `id-token`, `spawn`, `archive`, `delete`, `sleep`, `send`, `alert`, `host`, `expose`/`unexpose`/`previews`, `self`/`orbs`/`transcript`/`search`, and `help`; and `pi-orb-gcp-identity`, the executable credential source for Google external-account configs (`docs/workload-identity.md`). The Dockerfile contract test asserts each is copied, executable and names source the image carries. Both shims derive their entry point from their own location (`/app` in images, the enclosing repository otherwise). The image sets the system gitconfig `credential.https://github.com.helper`.

Native images are amd64 only; Docker images are amd64 and arm64.

Docker image APT steps do one authenticated index update, at most two verified download-only acquisitions, then one offline install, never repeating dpkg writes; `Acquire::Retries` does not retry unexpected-size rejections. Attempt, failure and install edges appear in build logs (`docs/postmortems/2026-10-08-runtime-apt-size-mismatch.md`).

`pi-orb --help`, `-h` or `help` prints the full command reference; `pi-orb help <command>` and `pi-orb <command> --help|-h` print one section. A leading help flag ignores the rest and never runs the command. Help is static (no identity or network), writes stdout and exits 0; unknown commands or invalid help syntax print brief usage to stderr and exit 2.

## Docker provider

- Publishes the runtime port to an ephemeral loopback host port (`--publish 127.0.0.1:0:8080`) and reports the runtime address preferring that mapping, then the bridge IP, then the container name. Docker Desktop bridge IPs are not host-routable; the host port changes on every start, which is safe because `runtimeAddress` is an ephemeral observation.
- Creates containers with `--add-host=host.docker.internal:host-gateway`; the default control-plane URL handed to orbs is `http://host.docker.internal:<port>` (explicit configuration wins). This works on Linux, OrbStack and macOS Docker Desktop.
- **Inventory scope.** `PI_ORB_DOCKER_INVENTORY_SCOPE` stamps `pi-orb.inventory-scope` on containers and volumes. Scoped inventory requires that exact label; unscoped inventory excludes scoped containers. Direct operations and volume deletion verify scope before mutating. After `docker volume create` (which can return an existing volume unchanged), provisioning inspects the volume and requires the exact orb ID and scope before mounting; foreign ownership is a non-retryable `conflict`. This isolates E2E databases on a shared daemon without disabling orphan reconciliation. Scope is deployment ownership, not a spec input (`docs/postmortems/2026-10-05-e2e-docker-inventory-isolation.md`).
- Mock-model environment variables are forwarded for tests.

## Process provider

A test-only backend for environments without Docker (for example an unprivileged container without a Docker socket, `CAP_SYS_ADMIN`, writable cgroups or usable namespaces). It requires explicit `PI_ORB_HOST_PROVIDER=process` and is Linux-only: `launch` refuses other platforms with non-retryable `operation_failed`, and launch-dependent tests skip on macOS. `npm run dev:local` selects it with embedded PGlite (`docs/stack.md`).

- `stateDirectory` is required (`PI_ORB_PROCESS_STATE_DIR`, local default under `~/.pi-orb/process-hosts`). Each orb gets a `0700` directory with atomically written `host.json` (orb ID, incarnation, repository URL, harness, spec fingerprint, plaintext runtime token at mode `0600` for hash readback, loopback port, process group and birth identity, drain token, supervisor ID, desired state), a persistent `workspace/`, and stdout/stderr logs.
- The child runs with `PI_ORB_WORK_DIR=<host-dir>/workspace`, a provider-created private `HOME=<host-dir>/workspace/home` (no inherited `XDG_CONFIG_HOME`, since boot writes git's XDG config — `docs/agent-context.md`), the normal orb/bootstrap/broker environment, `PI_ORB_RUNTIME_PORT=<port>` (runtimes default to 8080), and `PI_ORB_CONTROL_PLANE_URL=http://127.0.0.1:<port>`.
- When `commandDirectory` is configured, the provider prepends `apps/orb-runtime/docker` to `PATH` (same `pi-orb` and credential shims as the images) and exports `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` naming the credential helper, after any inherited entries. The private `HOME` hides the developer's gitconfig, and environment configuration reaches every git the runtime spawns without owning a file in the home.
- Each execution host has a small Linux Python supervisor (`supervisor.py`, Python 3.9+, pidfd support). It establishes subreaper ownership before publishing a ready receipt, watches control-plane identity through a pidfd, and drains descendants (including detached shells and dev servers) when the runtime or owner dies. A matching durable drain receipt is required before relaunch, disposal or workspace removal; missing or mismatched receipts fail closed. The provider writes desired `stopped` before termination and relaunches only desired-running hosts after verified drain. Elapsed time never proves cleanup (`docs/postmortems/2026-10-13-process-discard-deadline.md`). This is lifecycle management, not a security boundary.
- Group termination measures real liveness: `kill(-pgid, 0)` answers for unreaped zombies, so the ladder corroborates with a `/proc` member scan (`Z` counts as dead), treats `EPERM` from an all-zombie group like `ESRCH`, and forgets the child once absence is verified, so `observe` reports `stopped` immediately.
- `observe` reports a live child as `running` at `http://127.0.0.1:<port>`, and `stopped` when desired state is stopped and no child remains. `listManagedHosts` scans and validates metadata directories. A per-orb in-process lock suffices; cross-process provider concurrency is unsupported.
- There is no filesystem, process, UID, network, resource or environment isolation. Repository code can modify the host and other process orbs; use only trusted repositories. All runtimes share one network namespace, so previews are unsupported (`docs/http-exposure.md`). A close-before-spawn port race is accepted; a collision makes the child retry the same bind.
- It inherits host executables instead of image packages: Bun, git-crypt, rustup, Chromium, `gcloud` and `sudo` exist only if the developer's machine has them, and compiling `node-pty` needs Python 3 and `build-essential`. The workspace dependency supplies `agent-browser`.

It exercises the real runtime protocol, persistent sessions, stop/start and lifecycle without emulating Docker. One control-plane OS process owns the management tree; execution runtimes remain child processes for environment, termination and crash isolation. It does not reproduce image packaging, container networking, cgroups or restart policy; Docker/GCE E2E and deploy smoke remain authoritative there.

Rejected: a fake Docker CLI/API over processes; `proot`/`udocker` userspace images; nested `dockerd` with `vfs` but no namespace/cgroup privileges.

## GCE provider

### Placement and sizing

- Raw Compute Engine in one project (`playground-dev-6ae7`), single hardcoded zone `us-central1-a`, no multi-zone logic. All orbs share the project.
- Spot `n2d-highmem-2` (2 vCPU, 16 GiB), `instanceTerminationAction: STOP`. Machine type is in the fingerprint, so a size change applies at each orb's next ordinary Start.
- Spot capacity exhaustion (`ZONE_RESOURCE_POOL_EXHAUSTED`/`RESOURCE_POOL_EXHAUSTED` on insert or start) is a typed provisioning error that fails the orb visibly. No zone or on-demand fallback.
- 20 GiB disposable boot disk; fixed 50 GiB `pd-balanced` data disk per orb.
- Orb VMs run as the dedicated `pi-orb-orb-vm` service account (Logging writer only; the project's default compute account is disabled, so the provider always passes it) with the `cloud-platform` scope. Repository code can query the metadata server and mint this account's tokens, which is why it is minimal; the runtime bearer is likewise exposed to code on the VM (`docs/credentials.md`). Private custom images require `roles/compute.imageUser` for the provisioning identity (`infra/foundation/iam.tf`). A project container can read the VM service-account email from metadata; that identity is deliberately minimal and is not a separate security boundary.
- Networking: the control plane reaches the runtime on the internal IP through Direct VPC egress from Cloud Run (network `pi-orb`, subnet `pi-orb-us-central1`, 10.10.0.0/20, Private Google Access). The ephemeral public IP is outbound-only behind a deny-all-inbound firewall. No Cloud NAT.

### Disks

Each orb owns a separate data disk. Provisioning attaches an existing disk only when its exact `pi-orb-orb-id` label matches; retained disks keep their size and type. Only creation of a missing disk uses the pinned empty ext4 workspace template; retry and concurrent-create recovery verify the observed source image identity before adopting. Retained owned disks attach unchanged after template changes with no source-image requirement.

The guest requires a 50 GiB disk containing an ext4 filesystem of exactly that size. Admission reads capacity, type and size without formatting, growing or repairing; it mounts `/workspace` with normal journal handling. Missing, unsupported, wrong-size or unmountable storage fails boot visibly. Full read-only integrity checking is a build gate on the empty template, not a per-restart check. A stale "format" flag was rejected because it can authorize destruction after disk reuse (`docs/postmortems/2026-09-08-workspace-image-readonly-check.md`).

### Lifecycle mapping

- `provision` inserts the instance only when absent. Stop and Spot recovery restart the same instance (`instances.start`) with disks intact.
- Spot preemption appears as `TERMINATED`. The provider does not consult Cloud Logging and logs "likely preemption". GCE status lags guest power-off by 30 s or more, so preemption may surface through runtime silence instead (`docs/postmortems/2026-08-07-preemption-lost-turn.md`). An honest `host_preempted` label, if ever wanted, belongs in `diagnose()`. Rejected: a best-effort history drain on the ~30 s preemption notice; the unreplicated tail is recovered on the next start.
- Failed compute is disposed, not restarted in place: a hard stop during Docker layer extraction left a mountable boot disk with corrupt layers that Docker reported as `Already exists`, and re-pull or same-VM restart reused the poisoned cache (`docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`, `docs/postmortems/2026-08-12-spot-preemption-corrupt-entrypoint-layer.md`). Deleting the instance removes the auto-delete boot disk and preserves `/workspace`.
- The native `runtime_never_answered` sub-deadline (`docs/lifecycle.md`) sits above the guest's 10-minute workspace-unit bound and below the create/start deadline.

### Native image

A minimal Debian 12 image runs the runtime directly under systemd; the VM is the isolation boundary. COS was rejected: it does not support non-containerized applications or a host package manager, and the developer environment (`sudo apt-get` hooks, browser libraries, toolchains) needs both.

- **Minimal package set.** Every package must serve boot/operations, the runtime, Docker, or a prescribed capability. Exclude recommends, caches, build credentials and build-only artifacts; keep compilers because they are a prescribed capability. Project dependencies belong in setup hooks. Package purposes are in `infra/native-vm/PACKAGES.md`; the build records inventory and sizes.
- **Pins.** Base `projects/debian-cloud/global/images/debian-12-bookworm-v20261027`. Installation refreshes Debian packages, then pins Docker Engine/CLI `5:29.9.3-1~debian.12~bookworm`, containerd.io `2.4.2-3~debian.12~bookworm` and google-guest-agent `1:20261021.00-g1`. Build and acceptance parse daemon configuration and check package versions before checking that daemons are disabled.
- **Rollback** is a new forward-generation release adopted through ordinary stopped-compute replacement; running guests adopt a new image only through Stop/Start.
- **Build and release.** `npm run native-image:build` (procedure: `infra/native-vm/README.md`; release flow: `docs/deployment.md`) snapshots sources, builds on a disposable on-demand `e2-standard-4` builder, seals, captures the runtime image and an empty 50 GiB ext4 workspace image, validates a fresh VM and emits a manifest with source hashes, base image, package inventory and output resource/ID. Releases reject dirty sources and unvalidated images. Application code is baked in; no boot-time download. Images have unique names, are retained for rollback, and are rebuilt for OS/security updates. Effects run behind injected gcloud adapters with unit/DST coverage; Packer was rejected for that reason. The builder machine is fixed (no machine/zone fallback) after `n2d-highmem-4` stockouts (`docs/postmortems/2026-09-30-native-mcp-qualification.md`).

### Boot and supervision

- `workspace.mount` mounts the data disk at `/workspace` before any dependent service. Mount failure prevents the runtime and Docker from writing into an empty boot-disk directory. The mount is ordered after disk validation and outside systemd's implicit `local-fs.target`; image validation verifies the complete enabled `multi-user.target` graph, because checking only custom units missed an implicit-dependency cycle (`docs/postmortems/2026-09-07-native-workspace-systemd-cycle.md`). With the disk absent, runtime, Docker, containerd and the socket stay inactive and no environment is written; the device job expires after 90 s, and SSH also waits for local filesystems, so the serial console is the diagnostic channel.
- A privileged bootstrap reads the `pi-orb-config` metadata document and writes runtime credentials to a root-owned mode-0600 environment file under `/run`. No instance identity or project secrets enter the image. Bootstrap retries transient metadata failures (network errors, timeouts, HTTP 5xx) for 60 s because the guest agent reconfigures networking at boot; HTTP 4xx fails at once. A recovered retry publishes a `metadata_retried` boot edge (`docs/postmortems/2026-10-10-bootstrap-metadata-network-race.md`).
- systemd starts a small TypeScript supervisor, which starts the runtime in its own process group, publishes the first ready or typed failed health edge, and forwards TERM/INT while observing the real exit. Health transport/schema errors retry without a supervisor deadline. Exit before terminal health publishes `runtime_exited_before_ready` with code or signal. systemd keeps restart, cgroup cleanup and outer startup-failure reporting. Folding supervision into the runtime was rejected: a process cannot report its own loader crash.
- After readiness the supervisor probes localhost every 10 s with a 2 s deadline and logs `runtime_health_failed`, `runtime_health_recovered` and `runtime_child_exited` edges (last local success, requested-shutdown status, exit code/signal) to the `pi-orb-boot` log. Healthy probes are silent. Compare these with control-plane request failures for the same instance and window (`docs/lifecycle.md`): local success near remote failures suggests a path problem; simultaneous local failure suggests guest trouble. Neither proves cause, a child exit does not prove OOM, and missing records prove nothing (`docs/postmortems/2026-10-16-c9a30a6d-restart-loop.md`).
- **SSH host keys.** The Google guest agent manager is the sole host-key producer. The host-key gate starts after and wants the manager but must not require its initial successful start, so a transient producer exit cannot latch SSH off. SSH requires gate success. The gate verifies the real instance ID, Google's ECDSA/Ed25519/RSA key pairs and matching published guest attributes within 90 s; mismatch or timeout fails closed with a guest diagnostic. No competing key generator, blind SSH retry or longer timeout (`docs/postmortems/2026-10-01-native-ssh-startup-dependency.md`).
- **Guest evidence.** Instance metadata enables guest attributes. Workspace, bootstrap, supervisor and runtime publish structured edges to guest attribute `pi-orb/boot-status` and Cloud Logging `pi-orb-boot`. A specific boot error is never overwritten by a generic systemd diagnostic; unit/journal evidence is published separately, and workspace capacity is reported only after mount. `diagnose()` reads these, and lifecycle folds them into failure records before discard. Runtime stdout/stderr lives only in journald and disappears with the VM, so anything needed after deletion must be published explicitly.
- Setup runs once per incarnation, secrets after setup, resume on every runtime start (`docs/orb-setup-hook.md`). Image replacement discards system-package changes made by setup; setup recreates them.

### Docker on native VMs

Docker Engine, Buildx and Compose are installed for project workloads. Docker, its socket and containerd are disabled at boot and on every later boot; the agent starts Docker with `sudo systemctl start docker`. Readiness and health never depend on Docker, and Docker errors are application errors, not an orb state. Orb Stop stops the VM, which also stops Docker-owned containers. A project may opt into its own startup policy.

**Durability.** Non-regenerable workload data, including Docker volumes, writable container layers and locally built images, must survive compute replacement. Docker `data-root` is `/workspace/docker`, and containerd's persistent `root` is `/workspace/containerd`; with the containerd image store, `data-root` alone does not retain images. Transient sockets and process state stay under `/run`. Both daemons require the mounted disk. Stores are preserved whole, including caches; cleanup may remove only positively identified regenerable data. Replacement never wipes stores to repair startup; store failures need visible diagnosis and data-preserving recovery. The containerd config edit is asserted by parsing the resulting TOML. Engine upgrades may apply upstream bookkeeping conversions to retained stores, never custom migrations (`docs/deployment.md`).

## Infrastructure decisions

- A simple TypeScript project needs no orb configuration file. Per-project machine sizing and arbitrary OS/package configuration are out of scope.
- Rejected: Cloud Workstations (extra per-vCPU and cluster fees, no Spot, and the custom control plane is still needed).
- Rejected: suspend/resume. On Spot `n2d-highmem-4` it saved only about 5–11 s over stop/start and adds a lifecycle path.
- Evaluated, not adopted: exe.dev microVMs (no stop/start and no durable-data/disposable-boot split; open question 35).
- Evaluated, not adopted: AWS Lambda MicroVMs (8-hour lifetime cap; durable state would have to live on external EFS; open question 37).
