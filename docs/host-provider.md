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

The contract shared by every provider is: a persistent filesystem plus a host running the orb runtime container image with provider-delivered environment variables (the broker pair in `docs/credentials.md` plus, when port exposure is enabled, the Tailscale variables in `docs/ports.md`, whose auth key providers mint only at actual host creation). Project secrets deliberately add nothing to this provider contract: the runtime fetches them through the existing broker URL/bearer after setup, so Docker, GCE, and process providers remain unchanged. Where that container runs — the local Docker daemon or a Container-Optimized OS VM — never appears in the control plane or lifecycle engine.

**Persistent home decision (2026-08-09).** The runtime user's complete Unix home is ordinary durable orb state, independent of any particular extension or tool. Every provider sets `HOME` to `<work-dir>/home`: `/workspace/home` in Docker/GCE and the corresponding per-orb process-host workspace path. The runtime independently creates that directory with mode `0700`, repairs its permissions on every boot, resets `HOME` to the authoritative path, and fails readiness with `home_init_failed` if it cannot establish it. This defense in depth prevents alternate providers/direct launches from silently writing home-relative state into a disposable container layer or the process provider's shared host home. Docker's writable layer and the GCE boot disk remain intentionally disposable; all software following `$HOME`/`os.homedir()` now lands on the attached orb filesystem alongside the explicitly placed repository, Pi session, and credential cache. Orb deletion removes the home with the same authoritative filesystem.

**Runtime tool baseline decisions (2026-08-08, extended 2026-08-09, 2026-08-12, 2026-08-22, and 2026-08-25).** The prescribed runtime image includes Python 3, the `python` → `python3` command alias, and Python virtual-environment support. Agents can use either command and create a project-local environment with `python -m venv .venv`; `pip` is available inside that environment. The image deliberately does not add global `python3-pip`: Debian's externally-managed Python policy favors virtual environments. The `zip` and `unzip` command-line tools are also installed by default so every image-backed orb can create and extract ZIP archives.

Rust is also prescribed. The image includes a checksum-verified, version-pinned `rustup` multiplexer plus `build-essential` and `pkg-config`, but no image-layer Rust toolchain. The native build packages also make ordinary C/C++ addon compilation available inside every orb and source-build the runtime's approved `node-pty` dependency during image construction (`docs/terminal.md`); this supersedes the earlier decision not to ship a native build toolchain. On each runtime boot, after establishing persistent `$HOME`, the runtime points `RUSTUP_HOME` and `CARGO_HOME` into that home and checks for a default toolchain. A fresh orb runs `rustup default stable`, making `cargo`, `rustc`, `rustfmt`, and Clippy available after one initial download; later boots reuse it without synchronizing the stable channel. Repository `rust-toolchain.toml` files may select additional toolchains through ordinary rustup behavior. Toolchains, installed Cargo commands, registry/git caches, and Cargo configuration therefore survive stop/start and runtime-image replacement as ordinary orb state, at the cost of one copy and first-use download per orb. Failure to establish the default is a retryable `rust_toolchain_init_failed` readiness failure rather than a ready orb whose documented toolchain is absent.

Browser automation is prescribed (decided 2026-08-09). The runtime dependency pins [`agent-browser`](https://github.com/vercel-labs/agent-browser) 0.33.2, exposes its CLI globally in the image, and installs Debian Chromium with its system libraries, rather than downloading a browser into a particular user's home at image-build time. This works on both supported image architectures and leaves `$HOME` available for agent-browser's per-orb sessions, profiles, and state. The appended system-prompt baseline names the tool and its `open` → `snapshot`/element-ref workflow so its availability is discoverable without replacing Pi's normal prompt resources.

The Google Cloud CLI is prescribed (decided 2026-08-22), alongside the GitHub CLI and git that image-backed orbs already carry. The image adds Google's `cloud-sdk` apt repository — armored keyring under `/usr/share/keyrings`, pinned with `signed-by` — in the same layer as the GitHub CLI and Tailscale repositories, and installs the `google-cloud-cli` package only. No extra components ship: not `google-cloud-cli-app-engine-*`, not `kubectl`. The base package brings `gcloud`, `gsutil`, and `bq`, and even so costs about 0.66 GB — the arm64 image measured 1.90 GB before and 2.57 GB after (SDK 581.0.0, 2026-08-22). That cost is accepted because agents working on GCP-hosted projects otherwise cannot inspect or operate the resources they are asked about. No credentials are baked into the image; an orb authenticates `gcloud` per use like any other tool.

`sudo` is prescribed (decided 2026-08-25, `docs/orb-setup-hook.md`). The repository-owned boot hooks match Amp's convention, and Amp scripts reach for `sudo apt-get …` throughout; the image had no `sudo` at all, so every such script failed on its first line. The runtime keeps running as root, where `sudo` is a no-op elevation — that is the point: installing the package is far cheaper than rewriting every repository's script, and it costs nothing an orb's agent could not already do. Running the runtime as an unprivileged user with passwordless `sudo`, as Amp does, stays a separate hardening decision (open question 42) and does not block the hooks.

Three point-of-use CLI shims are installed into `/usr/local/bin` and are part of the baseline: `gh` and `pi-orb-git-credential` for broker-backed GitHub auth (`docs/credentials.md`), and the multi-command `pi-orb` dispatcher. Its original workload-identity command (`docs/workload-identity.md`, added 2026-08-21), `pi-orb id-token --audience <audience> [--ttl-seconds <60..3600>]`, mints a short-lived OIDC token from the control plane using the provider-injected runtime environment and prints the JWT plus one trailing newline to stdout, so command substitution and executable credential sources can consume it directly. Since 2026-08-27, `pi-orb orbs [query] [--json]` lists/searches sibling metadata and `pi-orb transcript <orb-id> [--json]` reads a replicated conversation (`docs/control-plane-api.md`). Failures are concise stderr lines and per-class exit codes. Since 2026-09-05, plain `pi-orb archive` requests self-archival on user request (`docs/orb-archival.md`). The POSIX `sh` dispatcher execs the matching Node entry point (`apps/orb-runtime/src/id-token/cli.ts`, `apps/orb-runtime/src/inspection/cli.ts`, or `apps/orb-runtime/src/archive/cli.ts`), and the Dockerfile contract test asserts it is copied, executable, and names source the image carries. Alongside it the image bakes `scripts/pi-orb-gcp-identity` at `/usr/local/bin/pi-orb-gcp-identity`, the reviewed executable credential source a Google external-account configuration names (`docs/workload-identity-recipes.md`, added 2026-08-22).

The image also bakes pi-orb's own Pi skills at `/opt/pi-orb/skills` — outside `/workspace`, whose persistent volume would shadow them — and the resource loader adds that path to Pi's skill discovery (`docs/pi-adapter.md`, added 2026-08-22). They are `cloud-identity`, which teaches the in-orb agent how to federate with `pi-orb id-token`, and `boot-hooks`, the authoring guide for the repository's `.agents/setup` and `.agents/resume` (`docs/orb-setup-hook.md`).

The unsandboxed process provider cannot supply image packages: it inherits host executables. `rustup`, Chromium, and `gcloud` are therefore documented local-test prerequisites — `gcloud` and `sudo` are image-only, so a process-host orb has them only if the developer's machine already does — and whether `sudo` there elevates at all is that machine's business; Linux also needs Python 3 and `build-essential` to compile `node-pty`, while macOS uses its bundled prebuild. The workspace dependency supplies the `agent-browser` CLI, and each orb still keeps home-relative Rust and browser state in its private persistent home. The process provider now prepends the repository's `apps/orb-runtime/docker` directory to the child `PATH`, making the portable `pi-orb` dispatcher and the `pi-orb-git-credential` helper available exactly as they are in the image; this configured directory is part of the immutable host-spec fingerprint. Both shims derive their entry point from their own location — `/app` under `/usr/local/bin` in the image, the enclosing repository otherwise — so one file serves both hosts. **GitHub credential helper on process hosts (2026-09-04).** A process host has no system gitconfig to carry the image's `credential.https://github.com.helper` setting, and the orb's `HOME` is private, so the developer's global gitconfig does not reach it either; cloning a private repository failed with `could not read Username for 'https://github.com'`. When `commandDirectory` is configured the provider therefore exports `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` naming that helper, appended after any entries the inherited environment already carries. Environment configuration, not a written gitconfig file, because it reaches every git the runtime spawns — its own clone, Pi's shell tool, the terminal PTY — without owning a file in the orb's home; the `gh` shim, which shares that `PATH`, got the same self-locating entry-point fix. The baked skills directory remains image-only: `/opt/pi-orb/skills` does not exist and the loader omits it rather than reporting a missing resource.

`provision` returns the host ref together with `runtimeTokenHash` — the SHA-256 of the per-incarnation runtime token the host actually carries, minted at creation and read back from the delivery channel for existing hosts (docs/credentials.md). The lifecycle machine commits this observed hash next to the host ref and re-commits when either changes.

Decided shape of the future `GceOrbHostProvider` (not yet implemented):

- Each orb owns a separate persistent data disk, mirroring the Docker provider's volume/container split. The COS boot disk is disposable and is replaced on runtime-image upgrades without touching orb state.
- The runtime container is declared through COS instance metadata and pulled from Artifact Registry; COS restarts it on crash, providing the host-level supervision Docker's restart policy provides locally.
- `provision` creates the instance only when it does not exist. Recovery from a stop or a Spot preemption is `instances.start` on the same instance (restart-in-place); there is no recreate-and-reattach path in the common case.
- Spot preemption appears as instance state `TERMINATED`. Instance status alone does not distinguish preemption from other terminations, and the provider does not consult Cloud Logging to find out; it logs the cause as "likely preemption". Host-down detection, restart initiation, and restart outcome are all logged as structured lifecycle events.
- Networking: the control plane reaches the runtime on the instance's internal IP via Direct VPC egress from Cloud Run; the ephemeral public IP is outbound-only behind a deny-all-inbound firewall (see the infrastructure decisions below).
- Validated on real infrastructure (2026-07-30, during the Cloud Run WebSocket validation exercise): a COS VM with no external IP pulls the container from Artifact Registry over Private Google Access and serves WebSockets to Cloud Run via Direct VPC egress. Orb VMs run as the dedicated minimal service account `pi-orb-orb-vm` (Artifact Registry reader + log writer); the project's default compute service account is disabled, so the provider must always pass the dedicated one. The dev project has no default VPC — the validation created network `pi-orb` / subnet `pi-orb-us-central1` (10.10.0.0/20, Private Google Access), which the OpenTofu static plane should adopt.

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
      // Present only when this boot made a notable interrupted-turn resume
      // decision (docs/lifecycle.md); absent on ordinary boots.
      turnResume?: {
        outcome: "resumed" | "declined_already_resumed" | "resume_failed";
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

A fresh clone is written to a temporary directory and atomically renamed into place so a process crash cannot make a partial checkout look ready. Restart reuses a complete checkout/session and cleans or retries an incomplete temporary clone.

The runtime never replaces an existing session. Whether to create or load is decided solely from the persistent filesystem: if a session exists for this orb it must be loaded, and a session that exists but cannot be loaded is reported as `status: "failed"` with a non-retryable typed error such as `session_load_failed` — never treated as grounds for creating a fresh session. A new session may be created only when the filesystem contains none. This guarantees that the session identity the control plane records on first pull stays valid for the orb's entire life, so a session-header mismatch during replication can only mean a bug or filesystem corruption, never a legitimate replacement.

Expected initialization failures such as clone failure, invalid repository state, or unusable credentials are represented by `status: "failed"` long enough for the control plane to record the typed error. Unexpected process failure exits the process and is handled by provider supervision/reconciliation. Each provider configures its native runtime supervision while the host is meant to run (Docker restart policy initially, a system service on GCE later); an explicit provider `stop` disables/reconciles that supervision to stopped.

## Infrastructure decisions

- The first infrastructure backend is local Docker.
- The future cloud backend is raw Google Compute Engine, not Cloud Workstations.
- All cloud orbs will live in one GCP project rather than one GCP project per source project.
- The development GCP project has display name `playground-dev` and project ID `playground-dev-6ae7`.
- The current prescribed cloud location is the single hardcoded zone `us-central1-a`. No multi-zone or multi-region logic initially.
- The current prescribed GCE shape is Spot `n2d-highmem-4`: 4 vCPUs and 32 GiB RAM.
- Spot capacity exhaustion (`ZONE_RESOURCE_POOL_EXHAUSTED` on instance create or start) maps to a typed provisioning error that fails the orb and is shown to the user. There is no zone or on-demand fallback initially.
- Boot-failure detection (implemented; born from cloud smoke-testing): while an orb is `creating`/`starting`, the reconciler records a per-probe boot picture (host state, attempts, whether the runtime ever answered, last error) exposed to the UI as a `waiting_for_runtime` state detail. Because the runtime's health server starts before slow initialization, a running host whose runtime has never answered past `unreachableBootDeadlineMs` (3 minutes) fails fast as `runtime_never_answered` instead of burning the 15-minute deadline; the terminal error carries the probes plus provider diagnostics (`OrbHostProvider.diagnose`, reading the GCE guest-attribute startup markers). A transiently failing diagnose defers the failure one poll so evidence is never dropped. Deadline failures carry the same evidence. Covered by DST scenarios including the adversarial-scheduling case where a best-effort host stop is cancelled and repaired by the backstop sweep.
- Rollout caveat resolved (open question 32, implemented 2026-08-01): the GCE provider stamps `pi-orb-script-sha256` (and `pi-orb-repository-url`, the input needed to re-derive the script) into instance metadata at creation. Both `provision`-reuse and `start` compare the stamp against the script the current provider would generate; on mismatch — including pre-stamp instances, whose repository URL is recovered from the old script text — the host is repaired: stopped if running, `setMetadata` with the new script while preserving the runtime token (so the committed token hash stays valid), then started. This also delivers runtime-image upgrades to existing orbs on their next start, which restart-in-place previously never did. Residual: a draining stale revision can still "repair" a fresh host backward within its drain window; the surviving revision repairs it forward on its next pass, and provision/start only run while the orb is `creating`/`starting`, so a ready runtime is never bounced. Field-validated during the 2026-08-01 rollout: the draining old revision restarted an orb VM un-repaired mid-rollover (the caveat's second observed occurrence), and the next stop/start through the new code repaired it — stamps present, new runtime image running. Escalation observed 2026-08-06 (third occurrence, worst so far): the drain window is 12+ minutes, not the assumed ~2, and when the two revisions' expected scripts differ they duel — repeated setMetadata/start races and hard VM stops, one of which corrupted the host's docker layer cache mid-pull (`docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`).
- Repairs are fenced forward-only (decided and implemented 2026-08-06, closing the residual above). Every host also carries `pi-orb-script-generation`, a decimal deploy-monotonic number written on insert and rewritten by every repair; the provider takes it from `GceOrbHostProviderOptions.scriptGeneration` (control plane: `PI_ORB_SCRIPT_GENERATION`, infrastructure: `-var deploy_generation=$(date +%s)`, printed by `infra/build-push.sh`). `ensureCurrentScript` compares the stamp before acting: a host stamped *newer* than the running revision is left entirely alone — no stop, no `setMetadata`, no start, one log line, outcome `current` — while equal or lower generations repair on hash mismatch exactly as before. Equal-generation repairs must keep working: local development runs at generation 0 forever and still needs hash-driven repairs for config and feature-toggle changes. A missing or unparseable stamp reads as 0, the lowest generation, so pre-fencing hosts are repaired forward by the first revision that meets them rather than being fenced off from repairs permanently. The same rule makes a forgotten `-var deploy_generation=…` safe but degrading: that revision runs at 0, repairs nothing a real deploy stamped, and the next deploy that does carry a generation repairs forward — an upgrade delayed, never a repair backward. Driven by `mixed-generation.dst.test.ts` (docs/testing.md), which runs two reconcilers at different generations against one world; against the unfenced rule it fails within its first iterations on a backward repair (2 → 1), which 14 of 20 sampled schedules produce, at up to 3 repairs and 6 host stops for one create plus two stop/start cycles versus at most 1 repair fenced. **Field correction 2026-08-11:** the statement that a stale revision leaves a newer host “entirely alone” was true only inside `ensureCurrentScript`; that method returns `current`, after which `start()` still starts the host, and the stale reconciler can still run boot detection and transition durable state. A deleted Cloud Run revision did exactly that for 7 minutes 42 seconds after deletion. The script-write fence prevented a downgrade but was not a lifecycle-authority fence; drained-revision deletion is cleanup, not correctness. Incident: `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`; remediation is tracked in `TODO.md`.
- **Immutable-host replacement superseded in-place repair (decided 2026-08-12, implemented 2026-08-16; `docs/compute-replacement.md`).** The two preceding bullets are now incident history and the description of the *removed* mechanism, not the contract. `ensureCurrentScript`, `setMetadata` script/image rewrites, and every `repaired` outcome are gone from the GCE adapter; there is no in-place host-repair path left in the code.
  - **Immutable spec fingerprints.** Every provider exposes a pure `desiredSpecFingerprint({ orbId, repositoryUrl })` computed through one shared canonical helper (`apps/control-plane/src/adapters/spec-fingerprint.ts`: recursively key-sorted JSON, SHA-256) so two revisions building the same effective specification through different code paths cannot disagree. GCE hashes the runtime image, the rendered startup script, boot image and boot-disk size, machine type, subnetwork, service account and scopes, scheduling, and data-disk size — all read from the single `launchSpec` that also builds the instance-insert body, so a host cannot carry a setting the fingerprint does not cover. The fingerprint is rendered at incarnation 0 on purpose: rotating an incarnation must not read as a specification change. Zone and project ID are deliberately excluded (see `docs/compute-replacement.md`): the data disk is zonal, so a zone move would provision an empty workspace and is an operator migration rather than a replacement.
  - **The stamp lives on the compute.** GCE writes `pi-orb-host-spec-fingerprint` into instance metadata at insert; Docker writes the `pi-orb.host-spec-fingerprint` label; the process provider records `specFingerprint` in its `host.json`. Provision-reuse and `start` verify the stamp *before any state change* and return a typed `conflict` on mismatch — a stale-spec incarnation is never started, resurrected, or rewritten. `StartOrbHostRequest.expectedSpecFingerprint` is `string | null`; null means a legacy row that predates stamping and matches only unstamped compute, so pre-migration hosts restart in place until their next ordinary Start replaces them.
  - **The deploy generation fences the decision, not the write.** `PI_ORB_HOST_SPEC_GENERATION` (infrastructure: `-var deploy_generation=$(date +%s)`, clamped monotonically by `infra/release.sh`) reaches each adapter as `OrbHostProviderOptions.specGeneration` and is committed alongside the fingerprint as the orb's `host_spec_generation`. It replaces `PI_ORB_SCRIPT_GENERATION`/`scriptGeneration` and the `pi-orb-script-generation` comparison that used to gate repairs: only the ordinary start path compares specifications, and a revision configured *below* the committed generation declines with one edge and starts the existing compute unchanged. A draining revision therefore cannot replace newer-spec compute backward, exactly as it could not repair it backward.
  - **The GCE runtime image must be digest-pinned, and composition asserts it.** A moving tag would change host contents without changing the fingerprint, so `apps/control-plane/src/main.ts` rejects a non-digest `PI_ORB_RUNTIME_IMAGE` for the GCE provider through `isDigestPinnedImage` before any side effect. The Docker and process providers are deliberately exempt: local development runs the mutable `pi-orb-runtime:dev` tag. The consequence is accepted and local-only — rebuilding that image does not change the fingerprint there, so local compute is replaced when a *configured* input changes, not when the image content does.
  - **Transitional stamp during the rollover.** New instances still carry `pi-orb-script-generation` set to the current deploy generation. Nothing in the new code reads it back. Its only job is the one rollover window in which a draining pre-Stage-2 revision is still running: that code treats an absent stamp as generation 0 and would stop a brand-new VM and rewrite its script in place — the 2026-08-06 repair-war class. Stamping the current generation makes the old code read the instance as the future and leave it alone. Removal once no revision with in-place repair can drain is tracked in `TODO.md`.
- Host-side evidence channels (implemented 2026-08-06, from `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`, where a container crash-looped for hours with nothing to look at). Three orthogonal channels, all set up by the GCE provider:
  - **Guest attributes are explicitly enabled.** `enable-guest-attributes=TRUE` now goes into instance metadata. It was never set before, and guest attributes are off by default — so every `report()` PUT from the startup script had been 404ing into its own `|| true` and `diagnose` had always returned null in the cloud. The startup-marker mechanism was correct and simply switched off; this is why the incident's `runtime_never_answered` errors carried no host diagnostics.
  - **Container logs go to Cloud Logging.** `google-logging-enabled=true` in instance metadata turns on COS's logging agent, which ships the runtime container's stdout/stderr off the VM. This is the only evidence channel that outlives the host, which matters because the lifecycle machinery stops failed hosts aggressively; the incident's crash-loop stack trace existed from the first failed boot but was reachable only over SSH.
  - **A container-state reporter keeps talking after the startup script exits.** The script writes a small bash loop to `/var/lib/pi-orb-container-reporter.sh` and launches it with `systemd-run --unit=pi-orb-container-reporter --collect --property=Restart=always`; every 15 s it publishes `status=… restartCount=… lastExitCode=… at=…` (one `docker inspect`, one metadata-server `curl`) to the `pi-orb/container` guest attribute. A transient systemd unit rather than a background child on purpose: COS runs startup scripts from a systemd unit whose exit reaps its whole cgroup, which `setsid`/`nohup` do not escape. Re-running the script (every boot, or by hand) stops and resets the unit before rewriting the file, so reporters replace rather than stack, and a failure to start one reports `container-reporter-failed` instead of failing the boot under `set -euo pipefail`.
  Both metadata keys were originally *rewritten* by the startup-script repair path, which was then a host's only upgrade path. Since immutable replacement landed (2026-08-16) there is no rewrite: both keys are written on instance insert, and a host created before they existed adopts them when its next Start replaces it. `diagnose` queries both guest attributes and joins them: `startup-script: container-started imagePullAttempts=1; container: status=restarting restartCount=47 lastExitCode=1 at=…`. A failure reading the container attribute yields no container evidence rather than an Err — supplementary evidence must never make the whole diagnosis uncertain, because an Err defers the caller's boot-failure decision another poll.
- Probe failures name their cause (implemented 2026-08-06, same postmortem). undici reports every connection failure as the bare message `fetch failed` and hides the syscall error in `error.cause` (or, when several addresses were tried, in an `AggregateError`'s `errors`). The runtime client unwraps it at the adapter boundary — `fetch failed (ECONNREFUSED)` — so probe records and terminal errors distinguish "host up, nothing listening in the container" from `ETIMEDOUT`/`EHOSTUNREACH` routing and firewall failures. During the incident every probe read `fetch failed`; the one distinction would have pointed inside the container immediately.
- Spot preemption is handled purely as the existing crashed-host path: the provider observes the instance `TERMINATED`, and recovery starts the same instance again in place with its disks intact. Rejected for now: a best-effort history drain on the ~30-second preemption notice — it would convert most preemptions into near-clean stops, but the first cloud slice stays simple; the unreplicated tail is recovered on the next start as docs/history-replication.md already allows. Note that GCE instance status lags the guest power-off by 30 s+, so a preemption may surface through the silence/`unreachable_restart` path rather than as observed-`TERMINATED` (`docs/postmortems/2026-08-07-preemption-lost-turn.md`). The in-flight turn a preemption kills is recovered by interrupted-turn resume at the next runtime boot (`docs/lifecycle.md`), which keys off the session tail and needs no cause disambiguation; if honest `host_preempted` labeling is ever wanted, a `zoneOperations.list` preemption check belongs in `diagnose()`, not in the observation contract. **Field correction 2026-08-12:** restarting the same VM is not sufficient when a preemption interrupts its first image pull. Orb `6ceb79c1` was preempted after five layers completed; the next pull trusted those layers as `Already exists`, then the container crash-looped before Node with `docker-entrypoint.sh: exec format error`. The published amd64 digest and entrypoint layer were healthy elsewhere, strongly matching the hard-stop cache-corruption path predicted by `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md` without a deploy race; the stopped host's extracted layer was not directly inspected (`docs/postmortems/2026-08-12-spot-preemption-corrupt-entrypoint-layer.md`). A normal retrying `docker pull` does not repair layers dockerd already considers complete. **Decision 2026-08-12:** failed compute is disposed rather than repaired in place; GCE instance deletion removes the suspect auto-delete boot disk while preserving `/workspace`, and only a later explicit Start or current-failure message wake provisions an incarnation-fenced clean VM. The provider/lifecycle/store plan is `docs/compute-replacement.md`.
- **Field finding and remediation 2026-08-11 (awaiting live release smoke):** runtime image replacement was one-shot and destructive. The startup script removed the existing container before `docker run`; when the exact digest was absent, `docker run` implicitly pulled it once. A transient Artifact Registry header timeout therefore left the host with no runtime until another boot, causing the release smoke's real `runtime_never_answered` failure. The same digest pulled and started successfully on that later boot, ruling out a bad image. The script now stops but retains the old container, explicitly pulls the exact target image up to three times with 5 s then 10 s backoff, removes the old container only after a successful pull, and starts the replacement with `--pull=never`. Exhaustion reports `image-pull-failed attempts=3` and exits with the old container still present; success records `container-started imagePullAttempts=N`, preserving recovered-retry evidence after intermediate guest-attribute markers are overwritten. Shell-backed contract tests cover both paths. Production validation remains tracked in `TODO.md`; incident: `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`.
- Cloud orb VMs boot Container-Optimized OS and run the standard orb runtime container image pulled from Artifact Registry. The container is launched by a startup script rather than the konlet metadata declaration — konlet has no ordering guarantee against the data-disk mount the container depends on. Hard-won COS specifics encoded in that script: the root filesystem is read-only (docker credentials live on the stateful partition) and the COS host firewall admits only SSH by default (the script opens the runtime port). Startup progress and failures are reported through guest attributes, which the instance metadata must explicitly enable (see the host-side evidence channels bullet above). There is no baked VM image and no VM image pipeline. The orb environment is defined by the runtime container image on every provider (Debian 12 base, Node.js 24); which host runs that container is a provider implementation detail invisible to the control plane. **Alternative under evaluation (2026-08-11; not decided):** replace Docker-on-COS with a versioned immutable GCE image running the runtime as a non-root systemd service while retaining the separate persistent `/workspace` disk; the spike is tracked in `TODO.md`, and mutable in-place VM installs are not proposed.
- Orb VMs use no Cloud NAT: each has an internal IP (used by the control plane) plus an ephemeral public IP for outbound traffic only, behind a deny-all-inbound firewall. Revisit NAT if orb count grows.
- Node.js 24 is prescribed.
- A simple TypeScript project should require no orb configuration file.
- Per-project machine sizing and arbitrary OS/package configuration are not part of the first slice.

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
2. **No durable-data/disposable-boot split.** The persistent disk *is* the rootfs instantiated from the image at create time. GCE delivers runtime-image upgrades to existing orbs by rewriting the startup script and recreating the disposable boot disk; exe.dev has no way to re-image a VM without `rm` (which destroys `/workspace`). Existing orbs would be pinned to their creation-time runtime image unless upgraded in place over SSH. Provision-reuse token readback would also go over SSH exec instead of instance metadata.
3. **Network path inversion.** The control plane would reach the runtime through exe.dev's authenticated HTTPS proxy (`https://pi-orb-<orbId>.exe.xyz:8080` + `X-Exedev-Authorization` bearer) instead of a private VPC IP — `runtimeAddress` would need to grow provider-supplied headers, WebSocket forwarding through their proxy needs empirical verification, and the runtime broker Cloud Run service would have to move from `ingress=internal` to public ingress (acceptable: orb-token bearer auth is the real gate and was designed for exactly this).

Unverified empirically: WS through the proxy, `ls --json` field shape (state/health), duplicate-`--name` behavior (needed for provision idempotency), whether an in-VM halt sticks, actual `/exec` rate limits (per-orb `observe` polling should be amortized into one periodic `ls` regardless), and private-registry auth against Artifact Registry (which wants short-lived tokens or a long-lived `_json_key`; mirroring the image to a PAT-authenticated registry may be simpler). Full writeup: [`docs/EXE-DEV.md`](docs/EXE-DEV.md). See open question 35.

## AWS Lambda MicroVMs as a host provider (evaluated 2026-08-05 — feasible via externalized durable state; proposal, not decided)

AWS Lambda MicroVMs (launched June 2026; docs: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) were initially dismissed because of the hard maximum lifetime, then re-investigated on the premise that an orb can continue on a successor VM if the durable data survives. Conclusion: the lifetime cap is real and unavoidable — `maximumDurationInSeconds` caps a MicroVM at 28,800 s (8 h) spent in RUNNING **plus** SUSPENDED combined, TERMINATED is terminal, and there is no disk export, no volume attach/detach, and no image-from-running-VM API, so the local disk always dies with the VM. What makes it feasible anyway is that the durable-data/disposable-boot split can be reproduced with the durable side *outside* the VM: per-orb EFS (NFS through a customer-managed VPC egress connector; `additionalOsCapabilities: ["ALL"]` explicitly enables mounting filesystems) or, weaker, workspace sync to object storage from lifecycle hooks. The MicroVM becomes a disposable ≤8 h compute lease over an external filesystem, and the control plane rotates VMs proactively before the cap using the existing `stopping` drain machinery.

What the platform provides: Firecracker VMs booted from a pre-initialized disk+memory snapshot (image built by AWS from a Dockerfile zip in S3 on a managed AL2023 base; ~3 min builds, ~1–12 s to RUNNING measured by third parties), real lifecycle verbs (`run-microvm`, `suspend-microvm`, `resume-microvm`, `terminate-microvm`, `list-microvms`, `get-microvm` with `stateReason`), automatic idle suspend with optional auto-resume on traffic, per-VM public HTTPS endpoint with mandatory short-lived JWE auth tokens (`create-microvm-auth-token`, `X-aws-proxy-auth` header, port-scoped) and explicit WebSocket/HTTP2/gRPC/SSE support, lifecycle hooks (`/run`, `/suspend`, `/resume`, `/terminate`) POSTed to the app including on max-duration termination, per-VM 16 KB `runHookPayload` at run time, ARM64 only, sizes 0.5–8 GB baseline memory (4× vertical burst, vCPU = memory/2), disk 8–32 GB. Pricing is per-second (≈$0.126/h for the default 2 GB/1 vCPU baseline: $0.0000277/vCPU-s + $0.0000037/GB-s), suspended VMs cost only snapshot storage ($0.08/GB-month; suspend writes $0.0038/GB, resume reads $0.00155/GB). Regions: us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1 — cross-cloud from our GCP control plane, which is just public HTTPS API calls plus a new AWS credential surface, but EFS and the egress connector require owning an AWS VPC.

Mapping onto the port:

- **Durable data**: per-orb EFS access point mounted by the runtime in the `/run` hook (mounting during image build is useless — the NFS mount would be baked into a snapshot shared by all VMs, and NFS TCP state does not survive snapshot restore; `/resume` must revalidate the mount too). This preserves the GCE-style split better than exe.dev does: runtime-image upgrades are trivial (terminate, `run-microvm` from the new image version, remount the same EFS path).
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
