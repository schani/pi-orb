# Orb host provider

How orb compute is provisioned and managed: the `OrbHostProvider` port, runtime readiness, the Docker and GCE implementations, and evaluated alternatives. The lifecycle state machine that drives these operations is specified in `docs/lifecycle.md`.

## The `OrbHostProvider` port

The abstraction is named `OrbHostProvider`. The control plane and lifecycle state machine depend only on this interface; Docker is one implementation and GCE can be another. No control-plane service or HTTP handler may invoke Docker directly.

The host provider only manages infrastructure. It does not know about Pi, Claude Code, conversations, prompts, or history replication.

```ts
type OrbHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

type OrbHostProviderOperation = "provision" | "start" | "stop" | "destroy" | "observe" | "list";

interface OrbHostProviderError {
  type: "orb_host_provider_error";
  provider: string;
  operation: OrbHostProviderOperation;
  code: "unavailable" | "conflict" | "invalid_state" | "operation_failed" | "cancelled";
  message: string;
  retryable: boolean;
}

// In-process adapter context; never serialized on the wire.
interface OperationContext {
  signal: AbortSignal;
}

interface OrbHostRef {
  provider: string; // e.g. "docker" or "gce"
  resourceId: string; // container ID, instance name, etc.
}

interface ProvisionOrbHostRequest {
  orbId: string;
  incarnation: number;
  bootstrap: {
    repositoryUrl: string;
  };
}

interface OrbHostObservation {
  ref: OrbHostRef;
  orbId: string;
  incarnation: number; // unstamped legacy compute is incarnation 0
  state: OrbHostState;
  lastStartedAt?: number; // last host start, epoch milliseconds

  // Ephemeral observation; never authoritative persisted state.
  runtimeAddress?: {
    baseUrl: string;
  };

  failure?: {
    code: string;
    message: string;
  };
}

interface OrbHostProvider {
  readonly kind: string;

  /**
   * Idempotent by orbId. Creates and starts the host, or returns the
   * existing matching host. Resolving means infrastructure is running,
   * not that the orb runtime has passed health checks.
   */
  provision(
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<
    { ref: OrbHostRef; incarnation: number; runtimeTokenHash: string },
    OrbHostProviderError
  >;

  /** Idempotent; refuses a resource carrying a different incarnation. */
  start(
    request: { ref: OrbHostRef; expectedIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;

  /** Gracefully stops compute while retaining its filesystem. Idempotent. */
  stop(ref: OrbHostRef, context: OperationContext): ResultAsync<void, OrbHostProviderError>;

  /** Removes fenced compute while preserving authoritative workspace/tailnet state. */
  discardCompute(
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError>;

  /** Permanently removes every provider resource owned by orbId. Idempotent. */
  destroy(orbId: string, context: OperationContext): ResultAsync<void, OrbHostProviderError>;

  /**
   * Returns null only when the provider definitively reports that the
   * resource does not exist. Provider/transport uncertainty is Err.
   */
  observe(
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError>;

  /** Used for reconciliation and leaked-resource discovery. */
  listManagedHosts(
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError>;
}
```

Every finite provider call receives an `OperationContext`. The provider passes its signal to the underlying HTTP/process API and returns a typed `cancelled` error after cancellation is observed. Cancellation does not promise rollback of an external side effect: an ambiguous provision/start/stop is resolved by later idempotent `observe` and reconciliation.

**Deletion extension implemented 2026-08-08.** `docs/orb-deletion.md` adds an idempotent `destroy(orbId, context)` operation and `destroy` operation discriminant. Unlike `stop`, it removes compute and the authoritative persistent filesystem; it addresses resources by deterministic orb identity so cleanup still works when `host_ref` was lost. The durable `deleting` lifecycle and tombstone sweep own retries and stale-provision races.

**Failed-compute disposal foundation implemented 2026-08-12.** Provision/start/results/observations now carry the compute incarnation. Docker containers, GCE instances, process refs, and provider stamps use incarnation-specific identity; legacy unstamped compute reads as incarnation 0. `discardCompute` enumerates exact-orb compute and removes only resources at or below its durable fence while preserving the workspace. Full `destroy` enumerates every incarnation before deleting storage. The process adapter persists the launched process-group leader so a replacement control-plane process can verify and terminate compute it did not launch. Lifecycle observation mismatches fail closed and create the ordinary discard intent. The deterministic stateful GCE model and the remaining crash/failpoint matrix are still implementation work in `docs/compute-replacement.md`.

There is intentionally no `unknown` host state. Failure to determine state is an error, not a durable state. There is also no `missing` state; definitive absence is represented by `observe()` returning `null`.

The interface intentionally omits:

- `restart`: the control plane composes `stop` and `start`;
- `exec`: runtime operations go through the orb runtime protocol;
- per-orb machine type, CPU, RAM, region, OS, or image configuration;
- harness-specific operations;
- runtime health and busy state, which belong to the runtime protocol.

Prescriptive infrastructure and provider-specific credential-delivery settings live in provider construction/configuration, for example:

```ts
new DockerOrbHostProvider({
  image: "pi-orb-runtime:<digest>",
  network: "pi-orb",
});

new GceOrbHostProvider({
  projectId: "playground-dev-6ae7",
  zone: "us-central1-a",
  machineType: "n2d-highmem-4",
  runtimeImage: "us-central1-docker.pkg.dev/…/pi-orb-runtime:<digest>",
});
```

The shared contract is a persistent filesystem plus a host running the orb runtime with provider-delivered environment variables (the broker pair in `docs/credentials.md` and optional Tailscale variables in `docs/ports.md`). GCE runs the runtime directly under systemd on Debian; the Docker provider uses a container, and the process provider launches a local process. Packaging never enters the lifecycle engine. Project secrets arrive through the existing broker URL/bearer.

**Persistent home decision (2026-08-09).** The runtime user's complete Unix home is ordinary durable orb state, independent of any particular extension or tool. Every provider sets `HOME` to `<work-dir>/home`: `/workspace/home` in Docker/GCE and the corresponding per-orb process-host workspace path. The runtime independently creates that directory with mode `0700`, repairs its permissions on every boot, resets `HOME` to the authoritative path, and fails readiness with `home_init_failed` if it cannot establish it. This defense in depth prevents alternate providers/direct launches from silently writing home-relative state into a disposable container layer or the process provider's shared host home. Docker's writable layer and the GCE boot disk remain intentionally disposable; all software following `$HOME`/`os.homedir()` now lands on the attached orb filesystem alongside the explicitly placed repository, Pi session, and credential cache. Orb deletion removes the home with the same authoritative filesystem.

**Runtime tool baseline decisions (2026-08-08, extended 2026-08-09, 2026-08-12, 2026-08-22, and 2026-08-25).** The prescribed runtime image includes Python 3, the `python` → `python3` command alias, and Python virtual-environment support. Agents can use either command and create a project-local environment with `python -m venv .venv`; `pip` is available inside that environment. The image deliberately does not add global `python3-pip`: Debian's externally-managed Python policy favors virtual environments. The `zip` and `unzip` command-line tools are also installed by default so every image-backed orb can create and extract ZIP archives.

Rust is also prescribed. The image includes a checksum-verified, version-pinned `rustup` multiplexer plus `build-essential` and `pkg-config`, but no image-layer Rust toolchain. The native build packages also make ordinary C/C++ addon compilation available inside every orb and source-build the runtime's approved `node-pty` dependency during image construction (`docs/terminal.md`); this supersedes the earlier decision not to ship a native build toolchain. On each runtime boot, after establishing persistent `$HOME`, the runtime points `RUSTUP_HOME` and `CARGO_HOME` into that home and checks for a default toolchain. A fresh orb runs `rustup default stable`, making `cargo`, `rustc`, `rustfmt`, and Clippy available after one initial download; later boots reuse it without synchronizing the stable channel. Transient DNS, connection, rate-limit, server, network-unreachable, and per-attempt timeout failures retry twice after 5 and 15 seconds; permanent failures stop immediately. The default-toolchain probe is limited to five seconds; fresh installation, retry reporting, and backoff share one three-minute budget. Each install command may use the full remaining budget, so a slow healthy download is not killed merely to reserve time for retries. In the first live smoke, that budget left room after the observed 339-second blank-disk preparation; the control plane’s 12-minute first-contact and 15-minute create/start deadlines remain the outer bounds. Retry and recovery edges are written to the native `pi-orb-boot` Cloud Logging log without replacing the guest readiness attribute; process and container hosts retain the same messages in runtime output. Repository `rust-toolchain.toml` files may select additional toolchains through ordinary rustup behavior. Toolchains, installed Cargo commands, registry/git caches, and Cargo configuration therefore survive stop/start and native-image replacement as ordinary orb state, at the cost of one copy and first-use download per orb. Failure to establish the default is a retryable `rust_toolchain_init_failed` readiness failure rather than a ready orb whose documented toolchain is absent. See `docs/postmortems/2026-09-07-native-rust-dns-bootstrap.md`.

Browser automation is prescribed (decided 2026-08-09). The runtime dependency pins [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.33.2, exposes its CLI globally in the image, and installs Debian Chromium with its system libraries, rather than downloading a browser into a particular user's home at image-build time. This works on both supported image architectures and leaves `$HOME` available for agent-browser's per-orb sessions, profiles, and state. The appended system-prompt baseline names the tool and its `open` → `snapshot`/element-ref workflow so its availability is discoverable without replacing Pi's normal prompt resources.

The Google Cloud CLI is prescribed (decided 2026-08-22), alongside the GitHub CLI and git that image-backed orbs already carry. The image adds Google's `cloud-sdk` apt repository — armored keyring under `/usr/share/keyrings`, pinned with `signed-by` — in the same layer as the GitHub CLI and Tailscale repositories, and installs the `google-cloud-cli` package only. No extra components ship: not `google-cloud-cli-app-engine-*`, not `kubectl`. The base package brings `gcloud`, `gsutil`, and `bq`, and even so costs about 0.66 GB — the arm64 image measured 1.90 GB before and 2.57 GB after (SDK 581.0.0, 2026-08-22). That cost is accepted because agents working on GCP-hosted projects otherwise cannot inspect or operate the resources they are asked about. No credentials are baked into the image; an orb authenticates `gcloud` per use like any other tool.

`sudo` is prescribed (decided 2026-08-25, `docs/orb-setup-hook.md`). The repository-owned boot hooks match Amp's convention, and Amp scripts reach for `sudo apt-get …` throughout; the image had no `sudo` at all, so every such script failed on its first line. The runtime keeps running as root, where `sudo` is a no-op elevation — that is the point: installing the package is far cheaper than rewriting every repository's script, and it costs nothing an orb's agent could not already do. Running the runtime as an unprivileged user with passwordless `sudo`, as Amp does, stays a separate hardening decision (open question 42) and does not block the hooks.

Three point-of-use CLI shims are installed into `/usr/local/bin` and are part of the baseline: `gh` and `pi-orb-git-credential` for broker-backed GitHub auth (`docs/credentials.md`), and the multi-command `pi-orb` dispatcher. Its original workload-identity command (`docs/workload-identity.md`, added 2026-08-21), `pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]`, mints a short-lived OIDC token from the control plane using the provider-injected runtime environment and prints the JWT plus one trailing newline to stdout, so command substitution and executable credential sources can consume it directly. Since 2026-08-27, `pi-orb orbs [query] [--json]` lists/searches sibling metadata and `pi-orb transcript <orb-id> [--json]` reads a replicated conversation (`docs/control-plane-api.md`). Failures are concise stderr lines and per-class exit codes. Since 2026-09-05, plain `pi-orb archive` requests self-archival on user request (`docs/orb-archival.md`). The POSIX `sh` dispatcher execs the matching Node entry point (`apps/orb-runtime/src/id-token/cli.ts`, `apps/orb-runtime/src/inspection/cli.ts`, or `apps/orb-runtime/src/archive/cli.ts`), and the Dockerfile contract test asserts it is copied, executable, and names source the image carries. Alongside it the image bakes `scripts/pi-orb-gcp-identity` at `/usr/local/bin/pi-orb-gcp-identity`, the reviewed executable credential source a Google external-account configuration names (`docs/workload-identity-recipes.md`, added 2026-08-22).

The image also bakes pi-orb's own Pi skills at `/opt/pi-orb/skills` — outside `/workspace`, whose persistent volume would shadow them. Docker and GCE set `PI_ORB_SKILLS_DIR=/opt/pi-orb/skills` after caller-supplied environment, and the runtime passes that provider-owned path to Pi's skill discovery (`docs/pi-adapter.md`).

The unsandboxed process provider cannot supply image packages: it inherits host executables. `rustup`, Chromium, and `gcloud` are therefore documented local-test prerequisites — `gcloud` and `sudo` are image-only, so a process-host orb has them only if the developer's machine already does — and whether `sudo` there elevates at all is that machine's business; Linux also needs Python 3 and `build-essential` to compile `node-pty`, while macOS uses its bundled prebuild. The workspace dependency supplies the `agent-browser` CLI, and each orb still keeps home-relative Rust and browser state in its private persistent home. The process provider now prepends the repository's `apps/orb-runtime/docker` directory to the child `PATH`, making the portable `pi-orb` dispatcher and the `pi-orb-git-credential` helper available exactly as they are in the image; this configured directory is part of the immutable host-spec fingerprint. Both shims derive their entry point from their own location — `/app` under `/usr/local/bin` in the image, the enclosing repository otherwise — so one file serves both hosts. **GitHub credential helper on process hosts (2026-09-04).** A process host has no system gitconfig to carry the image's `credential.https://github.com.helper` setting, and the orb's `HOME` is private, so the developer's global gitconfig does not reach it either; cloning a private repository failed with `could not read Username for 'https://github.com'`. When `commandDirectory` is configured the provider therefore exports `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` naming that helper, appended after any entries the inherited environment already carries. Environment configuration, not a written gitconfig file, because it reaches every git the runtime spawns — its own clone, Pi's shell tool, the terminal PTY — without owning a file in the orb's home; the `gh` shim, which shares that `PATH`, got the same self-locating entry-point fix. The process provider supplies its repository skills path through the same explicit `PI_ORB_SKILLS_DIR` contract; the runtime never guesses a path from its filesystem layout.

`provision` returns the host ref together with `runtimeTokenHash` — the SHA-256 of the per-incarnation runtime token the host actually carries, minted at creation and read back from the delivery channel for existing hosts (docs/credentials.md). The lifecycle machine commits this observed hash next to the host ref and re-commits when either changes.

Current `GceOrbHostProvider` contract:

- Each orb owns a separate persistent data disk, mirroring the Docker provider's volume/container split. Provisioning attaches an existing disk only when its exact `pi-orb-orb-id` label matches the requested orb; retained disks keep their existing size and type when defaults change. The Debian boot disk is disposable and is replaced on native-image upgrades without touching orb state.
- The native image contains the runtime and its systemd units. Instance metadata supplies configuration; systemd supervises the runtime independently of Docker.
- The workspace mount is ordered after disk validation and outside systemd's implicit `local-fs.target` transaction. Its explicit shutdown dependencies preserve clean unmounting. Image validation verifies the complete enabled `multi-user.target` graph, because checking the custom unit files alone does not expose cycles introduced by implicit target dependencies (`docs/postmortems/2026-09-07-native-workspace-systemd-cycle.md`).
- `provision` creates the instance only when it does not exist. Recovery from a stop or a Spot preemption is `instances.start` on the same instance (restart-in-place); there is no recreate-and-reattach path in the common case.
- Spot preemption appears as instance state `TERMINATED`. Instance status alone does not distinguish preemption from other terminations, and the provider does not consult Cloud Logging to find out; it logs the cause as "likely preemption". Host-down detection, restart initiation, and restart outcome are all logged as structured lifecycle events.
- Networking: the control plane reaches the runtime on the instance's internal IP via Direct VPC egress from Cloud Run; the ephemeral public IP is outbound-only behind a deny-all-inbound firewall (see the infrastructure decisions below).
- Validated on real infrastructure (2026-07-30, during the Cloud Run WebSocket validation exercise): a COS VM with no external IP pulls the container from Artifact Registry over Private Google Access and serves WebSockets to Cloud Run via Direct VPC egress. Orb VMs run as the dedicated minimal service account `pi-orb-orb-vm` (log writer); the project's default compute service account is disabled, so the provider must always pass the dedicated one. The dev project has no default VPC — the validation created network `pi-orb` / subnet `pi-orb-us-central1` (10.10.0.0/20, Private Google Access), which the OpenTofu static plane should adopt.

The Docker provider publishes the runtime port to an ephemeral host-loopback port at container creation (`--publish 127.0.0.1:0:8080`) and reports the runtime address preferring that mapping, then the container's bridge-network IP, then the container name (decided and implemented 2026-08-06; E2E-validated on macOS Docker Desktop the same day). The loopback mapping is what makes a host-run control plane work on Docker Desktop, where bridge IPs are not host-routable; Docker re-picks the host port on every container start, which is safe because `runtimeAddress` is contractually an ephemeral observation re-read at observe time. The reverse direction uses the same mechanism on every platform: containers are created with `--add-host=host.docker.internal:host-gateway`, and the default control-plane URL handed to orbs is `http://host.docker.internal:<port>` (an explicitly configured URL still wins) — replacing the earlier bridge-gateway-IP derivation, which resolved to Docker Desktop's VM rather than the host and left booting runtimes unable to reach the credential broker. Containers created before 2026-08-06 lack both the published port and the host alias and are simply removed and re-provisioned per the POC stance. A container whose port mapping is absent still yields the bridge-IP/container-name forms, which remain correct on Linux and for a containerized control plane on the same network.

## Runtime readiness

`OrbHostProvider` state and runtime readiness are separate. `provision()`/`start()` succeeding means compute is running; an orb becomes `running` only after the control plane receives a ready response from the runtime.

The runtime starts its health server before doing slow initialization:

```ts
type RuntimeHealth =
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "initializing";
      phase: "booting" | "cloning" | "setup_running" | "checking_project_secrets" | "loading_session" | "checking_auth";
    }
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "ready";
      sessionId: string;
      checkoutCommit: string;
      activity: "idle" | "busy";
      operationId?: string;
      // Present when boot notified an existing conversation or declined
      // auto-resume (docs/lifecycle.md); absent on a fresh conversation.
      turnResume?: {
        outcome: "resumed" | "notified_restart" | "declined_already_resumed" | "resume_failed";
        shape?: "trailing_tool_result" | "dangling_tool_calls" | "unanswered_user_message";
        headRecordId?: string;
      };
    }
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "failed";
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };
```

`GET /v1/health` returns HTTP 200 with this typed body whenever the process can serve HTTP. `initializing` and `failed` are reachable but not ready; the control plane interprets the discriminant instead of using status codes as lifecycle state. Network failure is distinct from a returned status.

Ready means all of the following:

- the runtime identity matches the requested orb;
- the repository exists in the authoritative filesystem at a resolved commit;
- the Pi session has been created or loaded from that filesystem;
- the configured Codex credential resolves successfully;
- history-pull and live WebSocket handlers are installed;
- the runtime can accept a new message when idle.

**Restart context (implemented 2026-09-05).** The image sets `PI_ORB_CONTAINER=1` on Docker and GCE. The runtime combines `/proc/sys/kernel/random/boot_id` with PID 1's start time from `/proc/1/stat` to identify the container execution lifetime; the kernel UUID alone would miss retained-container stop/start. `ProcessOrbHostProvider` forces `PI_ORB_CONTAINER=0` so even a containerized control plane cannot accidentally claim its unsandboxed children have a container-wide lifetime. Unknown/process-host execution identity uses conservative runtime-restart wording. No host metadata or provider API changed. Session-based notification, deduplication, crash-loop guarding, and failure visibility are specified in `docs/lifecycle.md`.

A fresh clone is written to a temporary directory and atomically renamed into place so a process crash cannot make a partial checkout look ready. Restart reuses a complete checkout/session and cleans or retries an incomplete temporary clone.

**Boot latency decision (2026-09-08):** after configuring the persistent home, the runtime starts persistent Rust toolchain setup and repository checkout concurrently. It waits for both branches before running `.agents/setup`, so the hook still sees the checkout and Rust toolchain, and a failed branch cannot leave boot work running. If both fail, the Rust failure wins deterministically; Rust retry and recovery edges remain reported while runtime health shows `cloning`.

The runtime never replaces an existing session. Whether to create or load is decided solely from the persistent filesystem: if a session exists for this orb it must be loaded, and a session that exists but cannot be loaded is reported as `status: "failed"` with a non-retryable typed error such as `session_load_failed` — never treated as grounds for creating a fresh session. A new session may be created only when the filesystem contains none. This guarantees that the session identity the control plane records on first pull stays valid for the orb's entire life, so a session-header mismatch during replication can only mean a bug or filesystem corruption, never a legitimate replacement.

Expected initialization failures such as clone failure, invalid repository state, or unusable credentials are represented by `status: "failed"` long enough for the control plane to record the typed error. Unexpected process failure exits the process and is handled by provider supervision/reconciliation. Each provider configures its native runtime supervision while the host is meant to run (Docker restart policy initially, a system service on GCE later); an explicit provider `stop` disables/reconciles that supervision to stopped.

## Infrastructure decisions

- The first infrastructure backend is local Docker.
- The cloud backend is raw Google Compute Engine, not Cloud Workstations.
- All cloud orbs will live in one GCP project rather than one GCP project per source project.
- The development GCP project has display name `playground-dev` and project ID `playground-dev-6ae7`.
- The current prescribed cloud location is the single hardcoded zone `us-central1-a`. No multi-zone or multi-region logic initially.
- The current prescribed GCE shape is Spot `n2d-highmem-4`: 4 vCPUs and 32 GiB RAM.
- Spot capacity exhaustion (`ZONE_RESOURCE_POOL_EXHAUSTED` on instance create or start) maps to a typed provisioning error that fails the orb and is shown to the user. There is no zone or on-demand fallback initially.
- Boot-failure detection (implemented; born from cloud smoke-testing): while an orb is `creating`/`starting`, the reconciler records a per-probe boot picture (host state, attempts, whether the runtime ever answered, last error) exposed to the UI as a `waiting_for_runtime` state detail. Because the runtime's health server starts before slow initialization, a running host whose runtime has never answered past `unreachableBootDeadlineMs` (12 minutes for native GCE; 3 minutes for Docker/process) fails fast as `runtime_never_answered` instead of burning the 15-minute deadline; the terminal error carries the probes plus provider diagnostics (`OrbHostProvider.diagnose`, reading the GCE guest-attribute startup markers). A transiently failing diagnose defers the failure one poll so evidence is never dropped. Deadline failures carry the same evidence. Covered by DST scenarios including the adversarial-scheduling case where a best-effort host stop is cancelled and repaired by the backstop sweep.
- The earlier in-place repair fence did not fence lifecycle authority: on 2026-08-11 a deleted stale Cloud Run revision continued reconciling for 7 minutes 42 seconds and could still start compute and fail durable orb state. Drained-revision deletion is cleanup, not correctness. Incident: `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`.
- **Immutable-host replacement superseded in-place repair (decided 2026-08-12, implemented 2026-08-16; `docs/compute-replacement.md`).** The preceding incident is history, not the contract. `ensureCurrentScript`, `setMetadata` script/image rewrites, and every `repaired` outcome are gone from the GCE adapter; there is no in-place host-repair path left in the code.
  - **Immutable spec fingerprints.** Every provider exposes a pure `desiredSpecFingerprint({ orbId, repositoryUrl })` computed through one shared canonical helper (`apps/control-plane/src/adapters/spec-fingerprint.ts`: recursively key-sorted JSON, SHA-256) so two revisions building the same effective specification through different code paths cannot disagree. GCE hashes the native image resource and numeric ID, per-instance configuration, and boot-disk size, machine type, subnetwork, service account and scopes, scheduling, and data-disk size — all read from the single `launchSpec` that also builds the instance-insert body, so a host cannot carry a setting the fingerprint does not cover. The fingerprint is rendered at incarnation 0 on purpose: rotating an incarnation must not read as a specification change. Zone and project ID are deliberately excluded (see `docs/compute-replacement.md`): the data disk is zonal, so a zone move would provision an empty workspace and is an operator migration rather than a replacement.
  - **The stamp lives on the compute.** GCE writes `pi-orb-host-spec-fingerprint` into instance metadata at insert; Docker writes the `pi-orb.host-spec-fingerprint` label; the process provider records `specFingerprint` in its `host.json`. Provision-reuse and `start` verify the stamp *before any state change* and return a typed `conflict` on mismatch — a stale-spec incarnation is never started, resurrected, or rewritten. `StartOrbHostRequest.expectedSpecFingerprint` is `string | null`; null means a legacy row that predates stamping and matches only unstamped compute, so pre-migration hosts restart in place until their next ordinary Start replaces them.
  - **The deploy generation fences the decision, not the write.** `PI_ORB_HOST_SPEC_GENERATION` (infrastructure: `-var deploy_generation=$(date +%s)`, clamped monotonically by `infra/release.sh`) reaches each adapter as `OrbHostProviderOptions.specGeneration` and is committed alongside the fingerprint as the orb's `host_spec_generation`. Only the ordinary start path compares specifications; a revision configured below the committed generation declines with one edge and starts the existing compute unchanged. A draining revision therefore cannot replace newer-spec compute backward.
  - **The GCE image is pinned by resource and numeric identity.** Composition requires `PI_ORB_GCE_IMAGE_RESOURCE` and `PI_ORB_GCE_IMAGE_ID`. The provider verifies `images.get` before provisioning and fingerprints both values, so deleting and recreating an image under the same name cannot silently change the desired artifact. Local Docker image selection remains independent.
- **Native guest evidence (implemented 2026-09-05).** Instance metadata enables guest attributes. Workspace, bootstrap, and runtime services publish structured edges to `pi-orb/boot-status` and Cloud Logging `pi-orb-boot`; the provider attaches these diagnostics to existing diagnosis-before-discard lifecycle records and user-visible failures. A missing or damaged workspace prevents bootstrap and runtime startup. Docker has no role in orb readiness. This preserves the durable-evidence rule established by `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`.
- Probe failures name their cause (implemented 2026-08-06, same postmortem). undici reports every connection failure as the bare message `fetch failed` and hides the syscall error in `error.cause` (or, when several addresses were tried, in an `AggregateError`'s `errors`). The runtime client unwraps it at the adapter boundary — `fetch failed (ECONNREFUSED)` — so probe records and terminal errors distinguish "host up, nothing listening in the container" from `ETIMEDOUT`/`EHOSTUNREACH` routing and firewall failures. During the incident every probe read `fetch failed`; the one distinction would have pointed inside the container immediately.
- Spot preemption is handled purely as the existing crashed-host path: the provider observes the instance `TERMINATED`, and recovery starts the same instance again in place with its disks intact. Rejected for now: a best-effort history drain on the ~30-second preemption notice — it would convert most preemptions into near-clean stops, but the first cloud slice stays simple; the unreplicated tail is recovered on the next start as docs/history-replication.md already allows. Note that GCE instance status lags the guest power-off by 30 s+, so a preemption may surface through the silence/`unreachable_restart` path rather than as observed-`TERMINATED` (`docs/postmortems/2026-08-07-preemption-lost-turn.md`). The in-flight turn a preemption kills is recovered by interrupted-turn resume at the next runtime boot (`docs/lifecycle.md`), which keys off the session tail and needs no cause disambiguation; if honest `host_preempted` labeling is ever wanted, a `zoneOperations.list` preemption check belongs in `diagnose()`, not in the observation contract. **Field correction 2026-08-12:** restarting the same VM is not sufficient when a preemption interrupts its first image pull. Orb `6ceb79c1` was preempted after five layers completed; the next pull trusted those layers as `Already exists`, then the container crash-looped before Node with `docker-entrypoint.sh: exec format error`. The published amd64 digest and entrypoint layer were healthy elsewhere, strongly matching the hard-stop cache-corruption path predicted by `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md` without a deploy race; the stopped host's extracted layer was not directly inspected (`docs/postmortems/2026-08-12-spot-preemption-corrupt-entrypoint-layer.md`). A normal retrying `docker pull` does not repair layers dockerd already considers complete. **Decision 2026-08-12:** failed compute is disposed rather than repaired in place; GCE instance deletion removes the suspect auto-delete boot disk while preserving `/workspace`, and only a later explicit Start or current-failure message wake provisions an incarnation-fenced clean VM. The provider/lifecycle/store plan is `docs/compute-replacement.md`.
- Cloud orbs boot a versioned minimal Debian image and run the runtime as `orb` (UID/GID 2000) under systemd. Configuration comes from the `pi-orb-config` metadata document; runtime credentials are written to a root-owned mode-0600 environment file under `/run`. Image build, validation, and immutable identity are described in `infra/native-vm/README.md`.
- Orb VMs use no Cloud NAT: each has an internal IP (used by the control plane) plus an ephemeral public IP for outbound traffic only, behind a deny-all-inbound firewall. Revisit NAT if orb count grows.
- **Requirement (2026-09-04):** GCP orbs must support running Docker workloads. Initial candidates evaluated: expose the existing per-orb VM Docker socket; run a separate Docker daemon inside the orb container; run the runtime and Docker directly on an immutable VM image; or use a separate Docker worker. Socket access grants control of the VM and the runtime container ([Docker security](https://docs.docker.com/engine/security/)); host-side bind mounts also need consistent workspace paths ([bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)). Nested Docker adds privilege, storage, and supervision concerns; native VM execution changes environment packaging; a separate worker adds lifecycle and workspace-sharing costs. The native Debian direction was selected on 2026-09-05; remaining choices are in `docs/open-questions.md`, question 48.
- Node.js 24 is prescribed.
- A simple TypeScript project should require no orb configuration file.
- Per-project machine sizing and arbitrary OS/package configuration are not part of the first slice.

## Native GCE runtime (implemented 2026-09-05; first deployed 2026-09-07)

A minimal Debian image runs the orb runtime directly on a dedicated VM as a systemd service, with Docker Engine, Buildx, and Compose installed for project workloads. The VM is the isolation boundary. The existing one-VM/one-data-disk model and immutable replacement machinery in `docs/compute-replacement.md` remain authoritative. Docker, its socket, and containerd are disabled at boot; the agent starts Docker explicitly. The guest validates that the workspace disk contains ext4. When the filesystem is smaller than the provisioned disk, a forced read-only filesystem check must pass before growth; the guest never repairs damage automatically. It mounts `/workspace` before any dependent service. Missing, damaged, or unsupported storage fails closed.

**Faster new workspaces (decided and implemented 2026-09-08).** The former full-device safety scan read a new 50 GiB disk for about 338 seconds of a measured 418-second fresh-orb boot. The builder creates and accepts a 10 GiB empty ext4 workspace image beside the native runtime image, and pins both its resource name and numeric identity in the release manifest and application configuration. Only creation of a missing data disk uses that image; retry and concurrent-create recovery verify the observed source identity before adopting the disk. The guest validates ext4, checks it read-only, grows it to the provisioned disk size, and mounts it without formatting or repair. Retained owned disks attach unchanged after template changes and require no source-image match. A missing or unsupported filesystem fails closed. Automated acceptance covers ambiguous create responses, concurrent creation, retained-disk replacement and Stop/Start, and image contents; the guest suite also exercises growth and damaged-image refusal through real e2fsprogs. A stale format flag was rejected because it can authorize destruction after disk reuse; binding one-shot authority to an exact disk would require a durable create/format/retry state machine without improving the image-backed result.

The production release at commit `17a29df` created, validated and grew a fresh workspace in 589 ms. The orb reached durable `running` 82.562 seconds after API creation, versus 418.473 seconds with the scan. Replacing an old-format orb attached its unchanged 50 GiB disk without a source-image requirement, validated its current-size filesystem in 824 ms, and preserved home, workspace and Docker-volume state. Same-spec Stop/Start reused the replacement VM and preserved the same state. Docker remained off until explicitly started and an immediate terminal passed after both boots. Exact image and timing evidence is in `docs/native-vm-prototype.md`.

**COS comparison (researched 2026-09-05).** Native execution does not by itself select Debian. COS images can be customized with [COS Customizer](https://cos.googlesource.com/cos/tools/+/refs/heads/master/src/cmd/cos_customizer/README.md), but Google's [documented limitations](https://docs.cloud.google.com/container-optimized-os/docs/concepts/features-and-benefits) explicitly exclude support for non-containerized applications and omit a host package manager. Its [filesystem](https://docs.cloud.google.com/container-optimized-os/docs/concepts/disks-and-filesystem) has a verified read-only root, stateless `/etc`, and execution restrictions on ordinary writable paths. Bundling compatible native binaries and arranging executable storage/systemd configuration is a possible experiment, not a validated supported environment. The mismatch is the whole developer environment, including existing `sudo apt-get` setup hooks, browser libraries, and native toolchains, not merely running Node. Debian was selected for that environment on 2026-09-05. COS remains a fit for the alternative of a containerized developer environment with access to the host Docker daemon.

**Minimal image (decided 2026-09-05).** Every installed package must serve boot/operations, the runtime, Docker, or an existing prescribed orb capability. Preserve the documented baseline, including browser automation, cloud/GitHub tools, Python, and native addon compilation; do not copy the Dockerfile package list without checking each dependency and its purpose. Project-specific dependencies belong in setup hooks. Exclude optional recommended packages, package caches, image-build credentials, and build-only artifacts; keep compilers where they also provide the prescribed native-build capability. Record the package inventory and installed sizes in the image build output. No desktop, unrelated services, or speculative tooling.

**Image regeneration and testing (required 2026-09-05).** Regeneration must be a single easy-to-use, documented command, as specified in `docs/deployment.md`. The production implementation requires thorough unit and deterministic simulation coverage under `docs/testing.md`; the successful VM experiment alone does not satisfy that gate.

**Packaging and releases (implemented 2026-09-05; first production release 2026-09-07).** `npm run native-image:build` builds and validates a versioned GCE image through injected gcloud adapters. Packer was considered; the selected orchestration keeps effects and timing behind the unit/DST boundary. Runtime source and the npm lockfile are shared with local container builds; native OS/tool installation lives in `infra/native-vm/`. The manifest records exact source hashes, base-image resource/ID, package inventory and output image resource/ID. Releases reject dirty sources and unvalidated images. Application code is baked into the image, avoiding a boot-time runtime download. Images have unique names; replacement pins both resource and numeric identity. Retain release images for rollback and rebuild for OS/security updates. See `docs/deployment.md`.

**Boot and supervision.** Mount the existing data disk directly at `/workspace`; preserve `/workspace/home`, repository, session, hook markers, and Tailscale state. A mount failure must prevent runtime or Docker workloads from writing into an empty boot-disk directory at that path. A privileged bootstrap reads per-instance metadata and writes protected ephemeral runtime configuration under `/run`; no instance identity or project secrets enter the image. systemd owns runtime restarts, bounded shutdown, and descendant cleanup. Test the existing SIGTERM cleanup, detached hook processes, PTYs, and runtime-owned userspace Tailscale under that supervision. Keep setup once per incarnation, secrets after setup, and resume every runtime start. Docker containers belong to the Docker daemon, so stopping the runtime service alone does not stop them; orb Stop must continue stopping the VM, and Docker is an optional workload tool (decided 2026-09-05): Docker, its socket, and containerd are disabled by default. The agent starts Docker explicitly with `sudo systemctl start docker`; runtime readiness and health do not depend on it. The image does not enable Docker on subsequent boots either; a project may opt into its own startup policy.

**Separate TypeScript runtime supervisor (decided 2026-09-08).** systemd starts a small supervisor process, which starts the runtime in its own process group, publishes the first ready or typed failed health edge to guest attributes and Cloud Logging, forwards TERM/INT, and then waits for the runtime's real exit. Health transport or schema errors retry without a supervisor readiness deadline. An exit before terminal health publishes `runtime_exited_before_ready` with its code or signal; diagnostic publication is bounded and cannot replace the runtime outcome. TypeScript shares the runtime's typed `neverthrow` boundaries and `determined` scheduling tests while the separate process retains loader-crash reporting. systemd retains restart, cgroup cleanup, and outer startup-failure reporting. Folding supervision into runtime `main.ts` was rejected because that process cannot report its own loader crash.

**User and authority.** An ordinary `orb` user with a fixed UID/GID, passwordless sudo, and Docker access gives conventional development-tool behavior. It does not isolate repository code from the VM: [Docker group membership grants root authority](https://docs.docker.com/engine/install/linux-postinstall/). Retain minimal VM service-account grants and brokered project identity; audit metadata reachability from project containers. The native image uses UID/GID 2000 with sudo. Existing active orbs will be archived by the user before deployment (decided 2026-09-05); there is no active-orb migration or ownership conversion. Image replacement discards system-package changes made by setup; setup must recreate them. No live platform patching is proposed.

**Docker durability (decided 2026-09-05).** Workload data that is not automatically regenerated must survive compute replacement, including Docker volumes. A stopped or detached resource is not necessarily disposable. Reject the earlier disposable-store proposal because it loses ordinary Compose volumes; preserving only bind mounts would not meet the requirement. Writable container layers and locally built images can also contain unique data, so classifying the entire image/snapshot store as cache is unsafe.

**Storage configuration (implemented 2026-09-05).** Use Docker's supported `data-root` setting with `/workspace/docker`, preserving volumes and their metadata together. For the containerd image store, configure containerd's persistent `root` separately as `/workspace/containerd`; keep transient sockets/process state under `/run`. [Docker documents both settings](https://docs.docker.com/engine/daemon/). Preserve the complete stores initially, even though this also retains caches; separating proven-regenerable cache is an optimization, not a durability prerequisite. Both daemons must require the mounted data disk and retain exclusive per-orb ownership. Replacement must never wipe their stores to repair startup. A persistent store failure needs visible diagnosis and data-preserving recovery; ordinary platform-runtime boot remains independent of Docker's image layers. Cache cleanup may reclaim only positively identified regenerable data, never infer safety from an unused volume/container/image. The prototype validates these paths on Docker 29.1.3/containerd 2.3.4. Store handling when updating Docker is deferred until that update.

**Diagnostics and acceptance.** Native services publish structured workspace, bootstrap, and runtime edges through guest attributes and Cloud Logging. Preserve diagnosis-before-discard, durable lifecycle edges, and user-visible failure details; Docker errors are ordinary application errors, not an orb readiness state. Preserve private runtime access and Tailscale previews, and validate Docker-published ports against the existing network policy. Acceptance must exercise the actual VM image: boot, Compose bind mounts and networking, image builds, browser/runtime E2E, shutdown, stop/start, image replacement with retained workspace, credential rotation, and mount/Docker/runtime failures. Provider changes need deterministic replacement/failure coverage; container E2E alone cannot validate systemd or guest-image behavior. Startup speed and release duration are measurements for the existing spike, not assumed benefits.

### Focused VM-image prototype (completed 2026-09-05)

The initial prototype established native runtime and storage behavior on disposable GCE resources; the subsequent implementation run validated the production provider and image builder. Deliver a repeatable image recipe, boot units, a scripted acceptance run, and a short evidence report. Run the actual orb runtime and its required tool baseline; a Node health server plus `docker run hello-world` is insufficient. Use isolated test identity/control-plane state and exact resource ownership for cleanup. Build two uniquely named image versions and run two VMs sequentially around one retained data disk. The replacement can be scripted directly for this experiment; that proves image/disk behavior, not production reconciler correctness.

Recipe and runbook: `infra/native-vm/`. Experimental findings, failures, measurements, and production limits: `docs/native-vm-prototype.md`.

Acceptance cases and their evidence:

1. **Build and boot:** create an image from a pinned Debian base, retain the package inventory with purposes/sizes, and boot without installing platform packages or downloading runtime code. Measure image build duration, image disk usage, and time to runtime readiness. Inject orb identity at boot; verify the image contains no instance credentials or initialized orb state.
2. **Usable orb:** connect the actual runtime to an isolated test control plane, complete a browser WebSocket handshake and agent shell turn, use a terminal PTY, run setup/resume and credential delivery, and exercise the browser/native-build baseline and Tailscale preview. The current E2E harness supports Docker and process hosts, so the VM connection needs an explicit test seam; its existing green suite is not evidence for native GCE behavior.
3. **Docker and retention:** build an unpublished local image; create a container with a unique writable-layer file; run a small Compose database with an ordinary named volume and a bind-mounted project directory. After acknowledged writes and an explicit database checkpoint, verify those records/files, image identity, container configuration, home, and session after same-VM stop/start and again after deleting the first VM/boot disk and attaching the retained disk to a fresh VM from the second image. Verify new platform image identity and preserved workload state together. Preserve data from stopped containers and unattached volumes too. Check setup once per incarnation and resume on each runtime start; define and observe project-container restart behavior.
4. **Failure behavior:** fail the workspace mount, terminate the runtime, and fail Docker startup on disposable fixtures. Assert no fallback writes to the boot disk, no duplicate runtime or leftover runtime-owned processes, no deletion of workload stores, and useful exported failure evidence. Exercise abrupt interruption separately with explicit synchronization and retain the first failure trace/logs; successful normal shutdown is not evidence of power-loss behavior.

A pass demonstrates the tested native runtime, package baseline, Docker workflows, retained-state replacement, and supervision behavior on the selected versions. The follow-up in `docs/native-vm-prototype.md` exercises the production GCE provider/reconciler through an isolated native launch adapter. The implementation run also validates release contracts and disk-full recovery. Foundation adoption, the corrected production deployment and retained-disk replacement validation completed on 2026-09-07. Docker engine updates are outside this change. The packaging decision is resolved in `docs/open-questions.md`, question 48. The evidence report separates assertions from timings, records failures and fixes, and identifies any proposed package/storage changes. Production rollout still follows `docs/deployment.md`.

## Local process provider for container-restricted test environments (decided and implemented 2026-08-07)

Some development environments already run pi-orb inside an unprivileged container and do not expose a Docker socket. A test-only `ProcessOrbHostProvider` is the simplest backend for these environments. It runs each orb runtime as an ordinary child process on the same host, with no meaningful isolation. It is not a production host and must require the explicit `PI_ORB_HOST_PROVIDER=process` setting rather than becoming the default. The control-plane process itself owns supervision; there is no separately launched supervisor daemon or second management command.

The evaluated pi coding-agent environment is suitable for this backend: Node 24, git, ripgrep, curl, `gh`, and Tailscale are already installed; `/workspace` is persistent and writable; and loopback TCP listeners are reachable by the control plane. It cannot run Docker as configured. There is no Docker CLI or `/var/run/docker.sock`; the effective capability set omits `CAP_SYS_ADMIN` and `CAP_NET_ADMIN`; the cgroup v2 mount is read-only; `mount(2)` is denied; and `unshare -Ur` is rejected by the outer seccomp/security policy. Installing `dockerd`, selecting the `vfs` storage driver, or using rootless Docker does not repair those missing kernel privileges. Docker is possible only if the environment's operator changes the outer sandbox: mount a trusted host Docker socket, or launch this environment privileged with usable namespaces and writable cgroups. The former grants host-equivalent control and the latter weakens the outer sandbox; neither can be enabled from inside an already-running environment.

Implemented mapping:

- `ProcessOrbHostProviderOptions.stateDirectory` is required. The adapter never chooses or embeds a filesystem path. Application composition reads `PI_ORB_PROCESS_STATE_DIR`, with a local convenience default derived from the user's home directory (for example `~/.pi-orb/process-hosts`), and passes the resolved path into the provider. Each orb gets a `0700` directory containing an atomically written metadata file, a persistent `workspace/`, and stdout/stderr logs. Metadata contains the orb ID, repository URL, plaintext runtime token (mode `0600`, needed for idempotent token-hash readback), assigned loopback port, and desired state. Child identity remains in the owning provider's in-memory table; runtimes cannot be adopted across control-plane processes because their IPC channel intentionally makes them exit when the owner disappears.
- `provision` creates or reuses that directory by orb ID, mints a token only for a genuinely new host, chooses an unused loopback port, and launches `node apps/orb-runtime/src/main.ts` as a child with `PI_ORB_WORK_DIR=<host-dir>/workspace`, `HOME=<host-dir>/workspace/home`, the normal orb/bootstrap/broker environment, and a new `PI_ORB_RUNTIME_PORT=<assigned-port>`. The provider creates the private home before launch rather than inheriting the control-plane user's home. The runtime reads the optional port variable and defaults to 8080 for Docker/GCE. When a command directory is configured the child also carries `GIT_CONFIG_*` entries pointing `credential.https://github.com.helper` at the `pi-orb-git-credential` shim on that `PATH` (2026-09-04), the process-host stand-in for the image's system gitconfig.
- The provider is the supervisor. It keeps an in-memory entry per running child, handles the child's `exit` event, and relaunches it while metadata still says `running`; `stop` writes `stopped` before sending TERM, waits, then uses KILL if needed. An IPC channel makes the runtime exit when its owning control-plane process disappears, preventing unmanaged children after a control-plane crash. On the next control-plane start, ordinary lifecycle reconciliation reads the durable metadata and starts the stopped runtime over the same workspace and token. This supplies the basic behavior expected from Docker's `--restart unless-stopped` without another daemon. This is lifecycle management, not a security boundary.
- `observe` reads metadata plus the provider's child table and reports a live child as `running` with `runtimeAddress.baseUrl = http://127.0.0.1:<port>`; it reports `stopped` when desired state is stopped and no child remains. `start` launches a child over the same workspace and token. `listManagedHosts` scans and validates metadata directories. A single-control-plane, per-orb in-process lock is sufficient for this test adapter; cross-process provider concurrency is explicitly unsupported.
- The child receives `PI_ORB_CONTROL_PLANE_URL=http://127.0.0.1:<control-plane-port>` by default. Mock-OpenAI variables are forwarded exactly as in the Docker provider. Tailscale injection should initially be rejected or disabled: all runtimes share one host/network namespace, so per-orb tailnet identity and arbitrary preview-port ownership no longer match the container provider's model.
- There is deliberately no filesystem, process, UID, network, resource, or environment isolation. Repository code can inspect and modify the host and other process-backed orbs. Use only with trusted test repositories. Port selection has a close-before-spawn race, accepted for this local test backend; an unlucky collision makes the supervised child retry the same bind until the port becomes free rather than adding socket activation or descriptor passing.
- Group termination measures real liveness, not signal echoes (2026-08-16). `kill(-pgid, 0)` answers for exited-but-unreaped members, so under load a stop/discard could spuriously report "group still exists after SIGKILL" — the one measured flake class in this suite. The termination ladder now corroborates the probe with a zombie-aware member scan (`/proc` states on Linux, `ps` states on macOS; states beginning with `Z` count as dead), treats `EPERM` from a group whose members are all zombies like `ESRCH`, and forgets the supervised child as soon as absence is verified instead of waiting for libuv's reap — so `observe` reports `stopped` the moment the ladder's answer is definitive.

This backend exercises the real runtime protocol, Pi adapter, persistent session, stop/start, and control-plane lifecycle without emulating Docker. One command starts the management tree: for example, `PI_ORB_HOST_PROVIDER=process npm run dev --workspace @pi-orb/control-plane`; that one control-plane OS process contains the provider/supervisor and creates runtime child processes only as orbs start. "Single process" therefore means no separate supervisor service, not that agent runtimes share the control plane's PID. Putting runtimes in the same JS isolate (or worker threads) is rejected: independent process environment, termination, crash handling, and agent-spawned subprocess cleanup are much simpler and more representative with child processes.

It does not reproduce the runtime image's package boundary, container networking, cgroups, Docker restart behavior, or image build, so Docker/GCE E2E and deploy smoke tests remain authoritative for those properties. PostgreSQL server binaries are not installed in the evaluated environment. Rather than installing and supervising a server, the process-mode composition uses embedded PGlite as described in `docs/stack.md`; database selection and location remain application configuration, not host-provider responsibilities. The root `npm run dev:local` script selects PGlite and the process provider, making the whole management tree one command while the control plane remains the only long-lived parent service. Adapter contract tests cover PostgreSQL migrations, CAS/transaction/history invariants, and credential-pointer CAS; the full-slice E2E passes with `PI_ORB_E2E_BACKEND=process`, including device login, real Pi tool and shell execution, live WebSocket handoff, replication, drain, and stopped history.

Rejected as more complicated without useful test coverage: implementing a fake Docker CLI/API over host processes; `proot`/`udocker`-style userspace image execution; and attempting nested `dockerd` with `vfs` but no namespace/cgroup privileges.

## exe.dev as a host provider (evaluated 2026-08-05 — feasible with caveats; proposal, not decided)

exe.dev (https://exe.dev) was evaluated as a third `OrbHostProvider`. It offers microVMs (Cloud Hypervisor) booted directly from an OCI container image in ~2 seconds, with a persistent disk as the VM's root filesystem, SSH exec access, an HTTPS proxy per VM (`https://<vm>.exe.xyz`, ports 3000–9999 forwarded, gated by per-VM bearer tokens mintable offline by signing with the account SSH key), and an API that is the SSH CLI verbatim (`POST https://exe.dev/exec`, 30 s timeout, per-key rate limits, `--json` output). Custom images from private registries are supported (`new --image --registry-auth`), as are `--env` at create, `--setup-script` (≤10 KiB, first boot only), `--tag`, `--name`, `ls --json`, `rm`, `restart`, `cp`, `resize`. Pricing is a subscription over a shared resource pool (≈$20/mo, 25 VMs on the personal tier; team pools and a usage-based "Cloud Pool" exist), so idle VMs cost roughly nothing beyond disk.

What maps cleanly onto the port: `provision` → `new --name=pi-orb-<orbId> --image=<runtime image> --env` (the runtime image boots as-is — no startup script, no disk-mount choreography, no konlet-style ordering problem); ownership/enumeration → name prefix + tags with `ls --json` (a dedicated exe.dev account also gives hard tenancy isolation); definitive absence → VM not in `ls`; `diagnose` → SSH exec (strictly better than GCE guest attributes); runtime→control-plane broker calls → already provider-agnostic URL+bearer by design.

Three real impedance mismatches:

1. **No stop/start lifecycle.** The CLI has only `new`/`rm`/`restart`; VMs are always-on (the pricing model makes idle nearly free, which removes most of the motivation for idle auto-stop). Our `stop` (idle stop, unreachable-restart, orphan sweep, `stopping` drain) would have to be emulated — e.g. halt the runtime process over SSH and record "stopped" in a VM tag so `observe` stays truthful — a virtual lifecycle layered on tags + exec, or the provider could report stop as a no-op with idle-stop disabled for this provider.
2. **No durable-data/disposable-boot split.** The persistent disk *is* the rootfs instantiated from the image at create time. GCE delivers native-image upgrades by replacing the disposable boot disk; exe.dev has no way to re-image a VM without `rm` (which destroys `/workspace`). Existing orbs would be pinned to their creation-time image unless upgraded in place over SSH. Provision-reuse token readback would also go over SSH exec instead of instance metadata.
3. **Network path inversion.** The control plane would reach the runtime through exe.dev's authenticated HTTPS proxy (`https://pi-orb-<orbId>.exe.xyz:8080` + `X-Exedev-Authorization` bearer) instead of a private VPC IP — `runtimeAddress` would need to grow provider-supplied headers, WebSocket forwarding through their proxy needs empirical verification, and the runtime broker Cloud Run service would have to move from `ingress=internal` to public ingress (acceptable: orb-token bearer auth is the real gate and was designed for exactly this).

Unverified empirically: WS through the proxy, `ls --json` field shape (state/health), duplicate-`--name` behavior (needed for provision idempotency), whether an in-VM halt sticks, actual `/exec` rate limits (per-orb `observe` polling should be amortized into one periodic `ls` regardless), and private-registry auth against Artifact Registry (which wants short-lived tokens or a long-lived `_json_key`; mirroring the image to a PAT-authenticated registry may be simpler). Full writeup: [`docs/EXE-DEV.md`](docs/EXE-DEV.md). See open question 35.

## AWS Lambda MicroVMs as a host provider (evaluated 2026-08-05 — feasible via externalized durable state; proposal, not decided)

AWS Lambda MicroVMs (launched June 2026; docs: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) were initially dismissed because of the hard maximum lifetime, then re-investigated on the premise that an orb can continue on a successor VM if the durable data survives. Conclusion: the lifetime cap is real and unavoidable — `maximumDurationInSeconds` caps a MicroVM at 28,800 s (8 h) spent in RUNNING **plus** SUSPENDED combined, TERMINATED is terminal, and there is no disk export, no volume attach/detach, and no image-from-running-VM API, so the local disk always dies with the VM. What makes it feasible anyway is that the durable-data/disposable-boot split can be reproduced with the durable side *outside* the VM: per-orb EFS (NFS through a customer-managed VPC egress connector; `additionalOsCapabilities: ["ALL"]` explicitly enables mounting filesystems) or, weaker, workspace sync to object storage from lifecycle hooks. The MicroVM becomes a disposable ≤8 h compute lease over an external filesystem, and the control plane rotates VMs proactively before the cap using the existing `stopping` drain machinery.

What the platform provides: Firecracker VMs booted from a pre-initialized disk+memory snapshot (image built by AWS from a Dockerfile zip in S3 on a managed AL2023 base; ~3 min builds, ~1–12 s to RUNNING measured by third parties), real lifecycle verbs (`run-microvm`, `suspend-microvm`, `resume-microvm`, `terminate-microvm`, `list-microvms`, `get-microvm` with `stateReason`), automatic idle suspend with optional auto-resume on traffic, per-VM public HTTPS endpoint with mandatory short-lived JWE auth tokens (`create-microvm-auth-token`, `X-aws-proxy-auth` header, port-scoped) and explicit WebSocket/HTTP2/gRPC/SSE support, lifecycle hooks (`/run`, `/suspend`, `/resume`, `/terminate`) POSTed to the app including on max-duration termination, per-VM 16 KB `runHookPayload` at run time, ARM64 only, sizes 0.5–8 GB baseline memory (4× vertical burst, vCPU = memory/2), disk 8–32 GB. Pricing is per-second (≈$0.126/h for the default 2 GB/1 vCPU baseline: $0.0000277/vCPU-s + $0.0000037/GB-s), suspended VMs cost only snapshot storage ($0.08/GB-month; suspend writes $0.0038/GB, resume reads $0.00155/GB). Regions: us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1 — cross-cloud from our GCP control plane, which is just public HTTPS API calls plus a new AWS credential surface, but EFS and the egress connector require owning an AWS VPC.

Mapping onto the port:

- **Durable data**: per-orb EFS access point mounted by the runtime in the `/run` hook (mounting during image build is useless — the NFS mount would be baked into a snapshot shared by all VMs, and NFS TCP state does not survive snapshot restore; `/resume` must revalidate the mount too). This preserves the GCE-style split better than exe.dev does: image upgrades are trivial (terminate, `run-microvm` from the new image version, remount the same EFS path).
- **`stop`**: short-term idle stop maps to `suspend-microvm` (state fully preserved, near-instant resume, ~zero cost) — but suspended time still burns the 8 h budget, so long-term stop must be flush + `terminate-microvm`, with "stopped" meaning "no VM exists; EFS holds the orb state" and `start` meaning "run a fresh VM + remount".
- **Rotation** (new lifecycle obligation no other provider has): the control plane must track VM age and proactively drain + terminate + re-run before the 8 h cap. The `/terminate` hook does fire on cap-exceeded termination, but its timeout is undocumented, so the hook is a backstop, not the plan.
- **`observe`/`list`**: `list-microvms` + `get-microvm`; definitive absence = not in list (plus EFS presence distinguishing "stopped" from "never existed"). Orb↔VM association goes through the run-hook payload and control-plane records; tags exist on images, per-VM tagging needs verification.
- **Network path**: same inversion as exe.dev — `runtimeAddress` grows provider-supplied headers (JWE token), the runtime broker needs public egress and token-refresh logic (tokens are minted per call with configurable expiry; maximum expiry undocumented), and WebSockets are officially supported (server-side connections can send headers, so the subprotocol workaround is browser-only).
- **Endpoint bandwidth is capped** (1–16 MB/s scaling with size) but applies only to endpoint traffic; git and package traffic uses the egress path.

Unverified empirically, in rough order of risk: (1) EFS/NFS mount through a VPC egress connector from inside a MicroVM — nothing documents it, it merely follows from "VPC egress + CAP_SYS_ADMIN"; (2) git/workspace performance on EFS; (3) NFS mount survival across suspend/resume; (4) `/terminate` hook timeout; (5) auth-token maximum expiry and mint rate limits; (6) account memory quota headroom (quota covers RUNNING+SUSPENDED combined). Full writeup: [`docs/AWS-MICROVMS.md`](docs/AWS-MICROVMS.md). See open question 37.

## Rejected: Cloud Workstations

Cloud Workstations was evaluated and rejected due to pricing and limited value relative to a custom control plane:

- normal Compute Engine charges;
- an additional `$0.05 × vCPU` per active workstation hour;
- a fixed `$0.20/hour` cluster fee;
- no documented Spot configuration in the stable or beta workstation configuration schema;
- we would still need custom health, history replication, restart recovery, and application control-plane logic.

## Rejected: suspend/resume

Suspend/resume was benchmarked on a Spot `n2d-highmem-4` in `us-central1-a`, using Debian 12 and Node.js 24. Across representative samples, resume generally saved only about 5–11 seconds relative to stop/start, with substantial variance. Suspend itself was slower than stop, though that latency could happen after the user left.

All tested resumes preserved process state, but the payoff did not justify another lifecycle path in the first version. One Spot preemption also occurred during the benchmark, reinforcing the need for full restart recovery.

Decision: implement stop/start only for now. All temporary benchmark cloud resources were deleted.

Native GCE boot timing (decided 2026-09-05; superseded 2026-09-08): the original
guest verified every byte before formatting a new workspace disk. Real 50 GiB admission exceeded the old
three-minute deadline while this check was still running. The workspace unit
has a ten-minute bound; GCE allows twelve minutes before declaring an unreachable
runtime, within the fifteen-minute create/start deadline. The preformatted-image
decision above removes that scan from new workspaces; this paragraph records the
historical timing that motivated it.
