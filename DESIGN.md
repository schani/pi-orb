# pi-orb Design

> **Status:** Living design document. It records decisions, current proposals, rejected approaches, evidence, and open questions. It is not yet an implementation specification.

## 1. Purpose

pi-orb runs an AI coding agent in an isolated, remotely managed environment called an **orb**. A user should eventually be able to invoke `pi-orb` from a project, get a web-based agent experience backed by an orb, disconnect, and later reconnect from another machine without tying the orb's lifetime to a local process.

Pi is the first agent harness, embedded through the Pi SDK. The host lifecycle, runtime protocol, history model, and replica storage should remain harness-agnostic enough to support another harness, such as Claude Code or Codex, later.

## 2. Current vertical-slice scope

The first target is deliberately narrow:

- Run locally using Docker.
- Drive the product entirely through the web UI; a local checkout is not required.
- Let users register a project with a name and public Git repository URL.
- Clone the repository into a fresh orb without caching or synchronization optimizations.
- Use a fixed orb runtime image and a prescribed environment.
- Embed Pi through its TypeScript SDK.
- Provide a web UI; no terminal TUI and no tmux-based interaction.
- Run exactly one Pi session/conversation per orb.
- Support a linear conversation and compaction. Do not expose branching, session switching, cloning, or forking initially. Steering a running operation and queueing follow-up messages while the agent is busy are also deferred beyond the first slice.
- Persist the orb itself only through its filesystem.
- Replicate the complete conversation history to the control plane database.
- Make stopped-orb history viewable immediately from the database without starting the orb.
- Put Docker behind an infrastructure abstraction that can later gain a GCE implementation.
- Build deterministic simulation testing into concurrency-critical code from the start using [`determined`](https://www.npmjs.com/package/determined).
- Do not focus on multiplayer yet.

The first version is not intended to be a generic VM configurator or a generic remote development platform.

## 3. Decisions made

### 3.1 Product and interaction

- The entire user interface will be web-based.
- The browser communicates only with the control plane, never directly with an orb runtime.
- The first slice has no authentication or authorization: anybody who can reach the control plane can perform every operation.
- The unauthenticated first slice must be treated as local/trusted-development software and must not be exposed publicly. Authentication is required before a public deployment.
- After routing and runtime connection, the control plane proxies one live WebSocket between browser and runtime without interpreting agent content.
- That WebSocket carries browser commands, transient streaming events, committed history-record notifications, runtime status, acknowledgements, and errors.
- The control plane never uses WebSocket traffic for persistence. Replica persistence happens only through separate control-plane HTTP pulls from the runtime.
- We will not use tmux as the user interaction or session-persistence mechanism.
- The orb's lifetime is independent of the browser or local CLI session.
- There is one agent/conversation per orb in the first version.
- Pi compaction is supported; Pi tree navigation and multiple sessions are not exposed initially.
- Multiple browser connections to one orb are allowed and may all issue requests; the runtime serializes mutations and broadcasts state.
- Multiplayer product features such as presence, attribution, and per-user permissions are out of scope for the first slice.

### 3.2 Agent runtime

- Pi will be embedded through `@earendil-works/pi-coding-agent` rather than launched through `pi --mode rpc`.
- The orb runtime is a Node.js service that owns the Pi SDK session and exposes a harness-agnostic HTTP/WebSocket protocol.
- The Pi adapter translates Pi-native persisted session entries into the shared history schema.
- A Pi extension may still be useful for Pi-specific instrumentation, but it is not the infrastructure supervisor.
- The orb runtime cannot restart itself reliably from inside its own failure domain. Docker initially, and GCE later, provide process/host supervision.
- If the runtime enters an unrecoverable state, it should exit so its host can restart it.

### 3.3 Infrastructure

- The first infrastructure backend is local Docker.
- The future cloud backend is raw Google Compute Engine, not Cloud Workstations.
- All cloud orbs will live in one GCP project rather than one GCP project per source project.
- The development GCP project has display name `playground-dev` and project ID `playground-dev-6ae7`.
- The current prescribed cloud location is the single hardcoded zone `us-central1-a`. No multi-zone or multi-region logic initially.
- The current prescribed GCE shape is Spot `n2d-highmem-4`: 4 vCPUs and 32 GiB RAM.
- Spot capacity exhaustion (`ZONE_RESOURCE_POOL_EXHAUSTED` on instance create or start) maps to a typed provisioning error that fails the orb and is shown to the user. There is no zone or on-demand fallback initially.
- Boot-failure detection (implemented; born from cloud smoke-testing): while an orb is `creating`/`starting`, the reconciler records a per-probe boot picture (host state, attempts, whether the runtime ever answered, last error) exposed to the UI as a `waiting_for_runtime` state detail. Because the runtime's health server starts before slow initialization, a running host whose runtime has never answered past `unreachableBootDeadlineMs` (3 minutes) fails fast as `runtime_never_answered` instead of burning the 15-minute deadline; the terminal error carries the probes plus provider diagnostics (`OrbHostProvider.diagnose`, reading the GCE guest-attribute startup markers). A transiently failing diagnose defers the failure one poll so evidence is never dropped. Deadline failures carry the same evidence. Covered by DST scenarios including the adversarial-scheduling case where a best-effort host stop is cancelled and repaired by the backstop sweep.
- Rollout caveat resolved (open question 32, implemented 2026-08-01): the GCE provider stamps `pi-orb-script-sha256` (and `pi-orb-repository-url`, the input needed to re-derive the script) into instance metadata at creation. Both `provision`-reuse and `start` compare the stamp against the script the current provider would generate; on mismatch — including pre-stamp instances, whose repository URL is recovered from the old script text — the host is repaired: stopped if running, `setMetadata` with the new script while preserving the runtime token (so the committed token hash stays valid), then started. This also delivers runtime-image upgrades to existing orbs on their next start, which restart-in-place previously never did. Residual: a draining stale revision can still "repair" a fresh host backward within its bounded drain window; the surviving revision repairs it forward on its next pass, and provision/start only run while the orb is `creating`/`starting`, so a ready runtime is never bounced. Field-validated during the 2026-08-01 rollout: the draining old revision restarted an orb VM un-repaired mid-rollover (the caveat's second observed occurrence), and the next stop/start through the new code repaired it — stamps present, new runtime image running.
- Spot preemption is handled purely as the existing crashed-host path: the provider observes the instance `TERMINATED`, and recovery starts the same instance again in place with its disks intact. Rejected for now: a best-effort history drain on the ~30-second preemption notice — it would convert most preemptions into near-clean stops, but the first cloud slice stays simple; the unreplicated tail is recovered on the next start as §3.5 already allows.
- Cloud orb VMs boot Container-Optimized OS and run the standard orb runtime container image pulled from Artifact Registry. The container is launched by a startup script rather than the konlet metadata declaration — konlet has no ordering guarantee against the data-disk mount the container depends on. Hard-won COS specifics encoded in that script: the root filesystem is read-only (docker credentials live on the stateful partition) and the COS host firewall admits only SSH by default (the script opens the runtime port). Startup progress and failures are reported through guest attributes. There is no baked VM image and no VM image pipeline. The orb environment is defined by the runtime container image on every provider (Debian 12 base, Node.js 24); which host runs that container is a provider implementation detail invisible to the control plane.
- Orb VMs use no Cloud NAT: each has an internal IP (used by the control plane) plus an ephemeral public IP for outbound traffic only, behind a deny-all-inbound firewall. Revisit NAT if orb count grows.
- Node.js 24 is prescribed.
- A simple TypeScript project should require no orb configuration file.
- Per-project machine sizing and arbitrary OS/package configuration are not part of the first slice.

### 3.4 Lifecycle

- We will implement stop/start and full restart recovery.
- We will not implement suspend/resume initially.
- The runtime should report health and busy/idle activity to the control plane.
- The control plane distinguishes an idle but healthy runtime from an unhealthy runtime. Failed health checks can lead to restart. The first vertical slice stopped only on explicit requests; idle auto-stop is now a decided design (below).
- Initial lifecycle constants are a 5-second readiness health poll during create/start, a 30-second unreachable-runtime grace period, and a 15-minute create/start deadline; all use injectable clocks and may be tuned later. While an orb is `running`, the ~10-second history pull doubles as the liveness signal, so no separate health poll runs.
- Pi's `agent_settled` lifecycle state is a useful agent-idle signal because it means no retry, compaction retry, or queued continuation remains.
- Pi SDK 0.83.0 does not expose a Claude Code-style shell registry or a reliable “agent-started processes remain” query. `AgentSession.isBashRunning` covers only currently awaited user `!`/`executeBash()` commands; model-invoked bash is observable only while its generic tool lifecycle is active. Pi internally tracks each built-in local shell PID while that invocation is awaited so it can kill the process group on abort/shutdown, but exposes neither the PID set nor a status getter and stops tracking when the shell invocation returns. Arbitrary detached descendants and processes spawned by extension/custom tools are therefore invisible to Pi after their launching tool returns. Whether OS process/cgroup inspection can provide a reliable idle signal remains unresolved.

**Decided — idle auto-stop and orphan-host sweep (proposed 2026-08-01, decided and implemented 2026-08-03 with the visible-tab refinement):**

Idle auto-stop reuses existing machinery rather than adding a new lifecycle path:

- The ~10-second history pull already returns `activity: idle | busy`. Add a `last_busy_at` column on the orb row (restart-stable, like `state_changed_at`; the wall clock is already injected). A pull observing `busy` — or any accepted mutating request, or an open live browser connection whose tab currently reports itself visible — refreshes it.
- When a `running` orb's reconciler observes `wallNow() - last_busy_at > idleStopAfterMs` (initial value: 15 minutes, matching Amp's pause window), it CAS-enters `stopping` with a persisted `stop_reason = 'idle'` so the UI can say "stopped (idle)" rather than presenting an unexplained stop; explicit stop/start commands clear the reason. From there the ordinary controlled-stop drain barrier applies unchanged. The effective idle anchor is `max(last_busy_at, state_changed_at, lastVisibleAt)`, so a freshly started orb always gets a full idle window. Two guards close timing holes: the reconciler also refuses to stop while the *most recent pull* observed `busy` (wall time can leap past the deadline — a clock jump or paused process — faster than pulls can refresh the persisted timestamp; found by DST), and `last_busy_at` writes go through a dedicated monotone `touchLastBusy` store operation with no `state_version` bump, so activity refreshes never conflict with lifecycle CAS or replication cursor writes.
- A browser connection counts as activity only while its tab is actually visible (decided answer to open question 10). Watching an agent work — or thinking about what to type next — should not power off the machine under the user, but a long-forgotten background tab must not keep a VM alive for days. The web client reports `document.visibilityState` over the live WebSocket: a presence frame on connect and on every `visibilitychange`. The control plane tracks the latest report per connection and treats the orb as browser-active only while at least one open connection has affirmatively reported `visible` — a connection that has not reported visibility counts as hidden, so the failure mode of a lost presence frame is an earlier stop, never a leak. A killed tab or slept laptop closes the socket, which removes the connection either way.
- Accepted limitation (open question 8 is resolved by the Pi SDK finding above; open question 9 stays open): detached background processes the agent started are invisible to `agent_settled` and would not prevent an idle stop. Amp ships the same trade-off with its 15-minute pause. If this bites, the answer is an OS-level signal (process/cgroup inspection in the runtime's health report), not a special background-job tool.
- DST coverage (implemented in `lifecycle.dst.test.ts` "idle auto-stop" and `orphan-sweep.dst.test.ts`): the idle deadline racing a just-accepted message burst (replica completeness holds whichever side wins); a busy runtime never idle-stopping even across simulated time jumps; a visible tab blocking the stop and a hide restarting the full countdown; and idle stop resuming correctly from persisted state alone after a control-plane restart with downtime.

Idle auto-stop cannot, by construction, handle a host the database has no row for — no row means no reconciler, no history pull, and no idle signal. That is the separate **orphan-host sweep** (open question 23), and the two should ship together:

- A periodic control-plane loop (`orphanSweepLoop`, every 5 minutes, running as a third background task beside the poller and reconciler; one instance is enough since the operation is idempotent) calls `listManagedHosts` — already on the provider port for exactly this purpose; the GCE implementation lists by the `pi-orb-orb-id` label, Docker by its managed-container naming.
- Each observation is joined against the orbs table. A running host whose orb row says `stopped`/`failed` is already covered by §5.2 reconciliation when `host_ref` matches; the sweep additionally catches rows whose `host_ref` was lost. A running host with *no* orb row at all — a provision whose commit was lost, or a database reset — is stopped (never deleted: the filesystem is authoritative and deletion does not exist in the first slice) and logged loudly as an integrity signal.
- The sweep only ever moves hosts toward "stopped"; it never starts or deletes anything, so a misfire costs a restart, not data.

### 3.5 Persistence

- The orb filesystem is assumed not to disappear. Containers, processes, and VMs may stop, crash, or be preempted, but the same persistent filesystem is available when the orb restarts.
- The filesystem is the authoritative persistence mechanism for the orb. Pi uses its normal persistent session file there.
- Conversation history is replicated to the control plane for immediate browsing and durable product history, but the replica is not used to reconstruct an orb or Pi session.
- Replication is pull-only in the first version. The control plane polls every active orb approximately every 10 seconds.
- Pulling and database persistence must not block the agent during normal operation.
- Temporary runtime, network, control-plane, or database failures are retried by the control plane from its last committed cursor.
- Immediately before a controlled stop, the control plane repeatedly pulls and commits history until the runtime returns no new complete records. The drain requires a reachable runtime; the lifecycle rules define the exceptions (never-ready orbs, absent or already-stopped hosts, non-retryable integrity failures).
- A stop that completes without a reachable runtime — a crashed or already-stopped host — may leave final records unreplicated until the next start. In that case the stopped-orb history view is complete only up to the last committed pull. This is a deliberate, narrow weakening of the complete-replication goal in exchange for never stranding an orb in `stopping`.
- Shutdown does not wait for Pi to settle. A user or parent agent may stop an orb during active work and accepts the risk of terminating an incomplete turn.
- If a pre-stop pull or database commit fails retryably, the stop must not proceed; the control plane retries while leaving the host running. A non-retryable replication-integrity failure (unknown cursor, session-header mismatch, mapping failure) instead abandons the drain, stops the host, and marks the orb `failed` with a typed error; the authoritative filesystem retains everything not yet replicated.
- Cloud SQL for PostgreSQL is preferred over AlloyDB for the first cloud deployment because cheaper small configurations are sufficient for expected load. Private IP only, with automated backups and point-in-time recovery from day one — the replica is the durable product history.
- Local development should use a local PostgreSQL-compatible database, likely a Docker container.
- Database access must be behind an interface so tests can use an in-memory/fake implementation where appropriate and local/cloud deployments can select different adapters.

### 3.6 Deployment direction

- The cloud control plane is expected to run on Cloud Run.
- At least one Cloud Run instance must remain provisioned so active-orb history polling can run continuously.
- The polling process must use always-allocated CPU/instance-based billing; a minimum instance with request-only CPU allocation is insufficient for reliable background work.
- Polling state and cursors remain in PostgreSQL because Cloud Run may restart even a minimum instance at any time.
- Multiple control-plane instances may poll the same orb concurrently. Correctness uses an optimistic cursor compare-and-swap in the commit transaction rather than a distributed polling lock or leader.
- Cloud Run WebSocket configuration is validated (open question 2): the platform behaves exactly as the architecture assumes once the request timeout is raised to 3600 s, and no VM fallback is needed.
- The cloud control plane sits behind Identity-Aware Proxy restricted to the `heyglide.com` Google Workspace domain (`domain:heyglide.com` as the sole `iap.httpsResourceAccessor`; hardcoded for now) until an application identity/authorization model exists (open question 24). The unauthenticated control plane must never be directly reachable from the public internet. Validated interactively: browser WebSockets pass through IAP after sign-in.
- Infrastructure must be managed as code.
- The IaC tool is OpenTofu. It manages only the static plane: VPC, firewall rules, Cloud Run, Cloud SQL, Artifact Registry, IAM. Per-orb VMs are dynamic resources created by `GceOrbHostProvider` through the GCE API at runtime and are never IaC resources.
- OpenTofu state lives in GCS (versioned bucket `pi-orb-tfstate-playground-dev-6ae7`, prefix `static-plane`), decided 2026-08-01 after the original local state was lost with its working directory. The live deployment was adopted into the fresh remote state via import blocks (`infra/imports.tf`) — 17 imports, zero destroys — rather than torn down; the import blocks stay in the repo as the adoption record. Lesson encoded: local IaC state in an ephemeral checkout is how you lose it.
- The control plane, orb runtime, shared protocol, and web UI will be written in TypeScript on Node.js 24.

### 3.7 Deterministic simulation testing

- Deterministic simulation testing is a first-class requirement from the beginning, not a later hardening phase.
- We will use the TypeScript [`determined`](https://www.npmjs.com/package/determined) package.
- Concurrency-critical domain code should accept its simulation/task abstractions so the same code runs with controlled scheduling and entropy in tests and `noSimulation` in production.
- The simulation boundary is each application's `domain/` directory; everything effectful sits behind adapter interfaces that simulations replace with deterministic fakes.
- Failing entropy traces must be recordable and exactly replayable.
- Explicit failpoints and scheduling checkpoints should cover replication, lifecycle, retry, reconciliation, and shutdown races.
- DST complements rather than replaces normal unit, database integration, Docker, browser, and eventual GCE tests.

### 3.8 Error handling

- First-party code does not use exceptions for expected or recoverable control flow.
- Synchronous fallible operations return `neverthrow` `Result<T, E>`.
- Asynchronous fallible operations return `ResultAsync<T, E>`.
- Public domain, adapter, and service APIs expose explicit discriminated error types rather than raw `Error` objects.
- Calls into third-party or platform code that can throw or reject must be caught at the immediate boundary with `Result.fromThrowable`, `ResultAsync.fromThrowable`, or an equivalent narrow wrapper, then mapped into a typed application error.
- Do not allow a rejected promise from an external dependency to escape into first-party domain code.
- Exceptions are allowed only where a framework or third-party callback contract requires them, such as a top-level framework error boundary. Such exceptions must be contained at that boundary and converted to/logged as typed failures where possible.
- Database transaction rollback must not depend on first-party code throwing. Use an explicit/controlled transaction API and return a `Result`.
- Lint rules should reject `throw` statements in first-party source, with narrowly documented overrides only for required boundaries.

## 4. High-level architecture

```text
Browser
   |
   | HTTPS / WebSocket
   v
Control plane
   |-- Web/API service
   |-- Orb lifecycle orchestration
   |-- History ingestion and live fan-out
   |-- Cloud SQL/PostgreSQL replica
   |
   | harness-agnostic orb runtime protocol
   v
Orb host
   |-- Docker container initially
   |-- GCE VM later
   |
   `-- Orb runtime (Node.js)
          |-- Pi SDK session and persistent harness history
          |-- history pull adapter
          |-- health and activity reporting
          `-- Pi history adapter
```

The browser talks only to the control plane. In the unauthenticated first slice, the control plane resolves/starts the orb, loads replicated history, and performs the cursor-aware handoff. It proxies the live WebSocket content-agnostically between browser and runtime. History persistence is a separate control-plane-to-runtime HTTP pull, so the proxy does not need to understand agent messages. This still requires operational validation for Cloud Run WebSockets.

## 5. Orb host abstraction

The abstraction is named `OrbHostProvider`. The control plane and lifecycle state machine depend only on this interface; Docker is one implementation and GCE can be another. No control-plane service or HTTP handler may invoke Docker directly.

The host provider only manages infrastructure. It does not know about Pi, Claude Code, conversations, prompts, or history replication.

```ts
type OrbHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

type OrbHostProviderOperation = "provision" | "start" | "stop" | "observe" | "list";

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
  bootstrap: {
    repositoryUrl: string;
  };
}

interface OrbHostObservation {
  ref: OrbHostRef;
  orbId: string;
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
  ): ResultAsync<OrbHostRef, OrbHostProviderError>;

  /** Idempotent. */
  start(ref: OrbHostRef, context: OperationContext): ResultAsync<void, OrbHostProviderError>;

  /** Gracefully stops compute while retaining its filesystem. Idempotent. */
  stop(ref: OrbHostRef, context: OperationContext): ResultAsync<void, OrbHostProviderError>;

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

There is intentionally no `unknown` host state. Failure to determine state is an error, not a durable state. There is also no `missing` state; definitive absence is represented by `observe()` returning `null`.

The interface intentionally omits:

- `destroy` and a `deleting` state: nothing in the first slice deletes an orb, so permanent host/filesystem removal is specified only when an orb-deletion feature exists;
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

The contract shared by every provider is: a persistent filesystem plus a host running the orb runtime container image with provider-delivered environment variables. Where that container runs — the local Docker daemon or a Container-Optimized OS VM — never appears in the control plane or lifecycle engine.

`provision` returns the host ref together with `runtimeTokenHash` — the SHA-256 of the per-incarnation runtime token the host actually carries, minted at creation and read back from the delivery channel for existing hosts (§15.1). The lifecycle machine commits this observed hash next to the host ref and re-commits when either changes.

Decided shape of the future `GceOrbHostProvider` (not yet implemented):

- Each orb owns a separate persistent data disk, mirroring the Docker provider's volume/container split. The COS boot disk is disposable and is replaced on runtime-image upgrades without touching orb state.
- The runtime container is declared through COS instance metadata and pulled from Artifact Registry; COS restarts it on crash, providing the host-level supervision Docker's restart policy provides locally.
- `provision` creates the instance only when it does not exist. Recovery from a stop or a Spot preemption is `instances.start` on the same instance (restart-in-place); there is no recreate-and-reattach path in the common case.
- Spot preemption appears as instance state `TERMINATED`. Instance status alone does not distinguish preemption from other terminations, and the provider does not consult Cloud Logging to find out; it logs the cause as "likely preemption". Host-down detection, restart initiation, and restart outcome are all logged as structured lifecycle events.
- Networking: the control plane reaches the runtime on the instance's internal IP via Direct VPC egress from Cloud Run; the ephemeral public IP is outbound-only behind a deny-all-inbound firewall (§3.3).
- Validated on real infrastructure (2026-07-30, see the validation runbook): a COS VM with no external IP pulls the container from Artifact Registry over Private Google Access and serves WebSockets to Cloud Run via Direct VPC egress. Orb VMs run as the dedicated minimal service account `pi-orb-orb-vm` (Artifact Registry reader + log writer); the project's default compute service account is disabled, so the provider must always pass the dedicated one. The dev project has no default VPC — the validation created network `pi-orb` / subnet `pi-orb-us-central1` (10.10.0.0/20, Private Google Access), which the OpenTofu static plane should adopt.

The Docker provider reports the runtime address using the container's bridge-network IP when one is available, falling back to the container name. On Linux, bridge IPs are routable from the host, so the first-slice control plane can run uncontainerized during development while orb runtimes stay reachable only on the private Docker network; a containerized control plane on the same network resolves the container-name form.

### 5.1 Runtime readiness

`OrbHostProvider` state and runtime readiness are separate. `provision()`/`start()` succeeding means compute is running; an orb becomes `running` only after the control plane receives a ready response from the runtime.

The runtime starts its health server before doing slow initialization:

```ts
type RuntimeHealth =
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "initializing";
      phase: "booting" | "cloning" | "loading_session" | "checking_auth";
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

### 5.2 Lifecycle transitions

The database state is desired/reconciliation intent as well as user-visible state. Every transition uses `state_version` compare-and-swap; provider operations remain idempotent, so competing reconcilers are harmless.

| Database state | Reconciler behavior                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creating`     | Ensure Codex auth, provision by orb ID, then wait for runtime ready.                                                                                                                                                                         |
| `starting`     | Ensure Codex auth, observe/start or reprovision the retained host/filesystem, then wait for runtime ready.                                                                                                                                   |
| `running`      | Observe the provider and derive runtime liveness from the ~10-second history pull; broadcast/replicate normally.                                                                                                                             |
| `stopping`     | Reject new live connections, close existing proxies, perform the final history-pull barrier, stop the provider host, then mark stopped. A non-retryable drain failure stops the host and marks the orb `failed` instead of retrying forever. |
| `stopped`      | Perform no runtime work; reconcile any unexpectedly running host back to stopped.                                                                                                                                                            |
| `failed`       | Preserve filesystem and error; wait for an explicit start request.                                                                                                                                                                           |

Commands:

- create inserts `creating` and wakes reconciliation;
- start is idempotent for `creating`, `starting`, or `running`; from `stopped` or `failed` it clears `last_error`, enters `starting`, and wakes reconciliation;
- stop is idempotent for `stopping` or `stopped`; from `creating`, `starting`, `running`, or `failed` it enters `stopping`;
- start while `stopping` returns `409 conflict`; the caller retries after stopped;
- runtime message requests are rejected once the database enters `stopping` because the control plane closes and refuses live proxy connections for that orb.

Reconciliation rules:

- retryable provider/network failures leave the current transitional state unchanged and retry with deterministic-clock exponential backoff capped at 10 seconds;
- a non-retryable provider error or runtime `failed` response transitions to `failed`;
- provider absence during `creating`/`starting` calls idempotent `provision(orbId, ...)` rather than assuming Docker/GCE semantics;
- provider absence or unexpected stop while the database says `running` transitions to `starting` and restores the host around the retained filesystem;
- a running provider whose runtime remains unreachable for a grace period is restarted with provider `stop`/`start`, without the controlled-stop drain because the runtime is already unhealthy; this rule applies in both `running` and `stopping`, so a pending drain is never stranded behind a dead runtime process inside a live host;
- after OAuth completion, each blocked `creating`/`starting` row is CAS-reentered with a fresh `state_changed_at` before host work, so user login time does not consume the host startup deadline;
- an orb becomes `running` only after ready identity/session/commit data have been persisted;
- when an orb has been `creating` or `starting` longer than the create/start deadline (measured from `state_changed_at` with the injected wall clock), the reconciler cancels in-flight provider operations, stops the host if one is observable (tolerating absence), and transitions to `failed` with a typed `deadline_exceeded` error; a later start begins a fresh deadline, and OAuth device-login wait time never counts because completion re-enters the state with a fresh `state_changed_at`;
- a retryable controlled-stop pull/commit failure leaves the orb in `stopping` and the host running, as specified by the shutdown barrier;
- a non-retryable replication-integrity failure (unknown cursor, session-header mismatch, mapping/validation failure) — whether during `running` polling or a `stopping` drain — stops the host and transitions to `failed` with a typed error; the same applies when a runtime cannot be restored to ready within the create/start deadline while a drain is pending;
- when stopping an orb that has never reached ready and has no `harness_session_id`, no user request could have been accepted, so the control plane may skip the history drain and stop the provider directly;
- if the provider host is definitively absent or already stopped during `stopping`, there is no running runtime to drain; mark `stopped` directly — complete records left on the persistent filesystem are found on the next start.

Use initial constants of a 5-second readiness health interval during create/start, a 30-second unreachable-runtime grace period, and a 15-minute create/start deadline; while `running`, liveness is derived from the ~10-second history pull instead of a separate health poll. These use injectable deterministic clocks. Time spent waiting for the user to complete a displayed OAuth device challenge ends when that challenge expires rather than consuming a separate hidden timeout.

Add `state_changed_at` to the orb row for transition deadlines; ordinary replication writes must not alter it. `updated_at` remains a general row-update timestamp.

Idle auto-stop (§3.4) enters `stopping` through the same transitions; it required no new lifecycle states — only the persisted `last_busy_at`/`stop_reason` columns and the reconciler's idle check.

## 6. Harness-agnostic orb runtime protocol

The runtime protocol describes agent-runtime behavior rather than Pi behavior. A future Claude Code or Codex adapter should be able to implement the same contract.

A conceptual in-process client boundary is Result-based:

```ts
interface OrbRuntimeClient {
  health(context: OperationContext): ResultAsync<RuntimeHealth, RuntimeClientError>;
  submit(input: RuntimeInput, context: OperationContext): ResultAsync<void, RuntimeClientError>;
  stopCurrentOperation(context: OperationContext): ResultAsync<void, RuntimeClientError>;
  pullHistory(
    request: PullHistoryRequest,
    context: OperationContext,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError>;
}
```

Finite runtime-client calls pass the signal to `fetch` or the simulated transport so a hung request cannot pin a reconciler forever. Cancelling `submit` only cancels the caller's transport wait; it does not retract a request the runtime may already have accepted. The in-memory request-identity rules in the ordering section resolve that ambiguity on retry. Aborting an active Pi operation remains the explicit `stopCurrentOperation` action.

Persistence is deliberately separate: the control plane never derives replica writes from WebSocket frames. It polls the runtime's HTTP `pullHistory` endpoint and commits only the complete records returned there.

### 6.1 Transport and control-plane handoff

The browser opens `/api/orbs/{orbId}/live` only after the normal control-plane HTTP API reports the orb as running. It offers the WebSocket subprotocol `pi-orb.runtime.v1`.

The first slice performs no authentication or authorization at either hop. The control plane resolves the orb, opens its runtime WebSocket, then forwards text frames and close/backpressure signals without parsing application frames. Because the browser sends `client.hello` immediately after its upgrade completes, the proxy installs browser message handlers synchronously before awaiting orb lookup or host observation, queues text frames during routing, and flushes them in order once the runtime socket opens. It emits no control-plane data frame into the runtime stream. Runtime endpoints should still remain reachable only from the control plane's local Docker network so the browser topology does not accidentally become a direct-browser/runtime API.

A connection race or unavailable runtime closes with `1013 Try Again Later`; the browser returns to the HTTP lifecycle API before retrying. Binary frames are not accepted.

This makes the runtime's `client.hello` the first application frame and avoids two nested handshakes or mixed control-plane/runtime frame namespaces. Authentication can later be added at the HTTP/WebSocket upgrade and control-plane-to-runtime connection without changing agent frames.

### 6.2 Handshake and synchronization

Every frame has `v: 1` and a discriminating `type`. The WebSocket subprotocol negotiates the major wire version; the per-frame version makes captured frames independently decodable.

```ts
interface ClientHello {
  v: 1;
  type: "client.hello";
  clientInstanceId: string; // stable UUID for this browser tab
  afterRecordId: string | null; // last complete record applied by the UI
}

interface ServerWelcome {
  v: 1;
  type: "server.welcome";
  at: string;
  connectionId: string;
  runtimeInstanceId: string;
  orbId: string;
  sessionId: string;
  capabilities: string[];
  limits: {
    maxIncomingFrameBytes: number;
    maxPromptBytes: number;
  };
}
```

The runtime rejects requests before `client.hello`. All normalized harness events and WebSocket handlers run on the same Node.js event loop. The hello handler performs synchronization preparation synchronously, without any `await`:

1. Read Pi's in-memory entries and the runtime's current normalized live state.
2. Compute the latest complete history boundary and all replay/reconstruction frames.
3. Append `server.welcome`, `sync.started`, history frames, reconstructing ordinary `runtime.event` frames, and `sync.completed` to the connection's normal ordered outbound writer.
4. Return from the hello handler; subsequent Pi events append to that same writer after `sync.completed`.

JavaScript run-to-completion semantics prevent a Pi callback from interleaving while these frames are prepared and enqueued. There is no special catch-up queue, second barrier, or internal event watermark.

The bounded outbound budget that protects the runtime from a slow consumer applies only to frames enqueued after the synchronization batch. The synchronization batch itself is exempt: it references entries Pi already holds in memory, so streaming it out under ordinary socket backpressure adds no asymptotic memory, and closing on its size would only recreate the same oversized batch on the next attempt. If post-synchronization frames overflow the budget while the batch drains, the connection is closed as usual. Because `afterRecordId` is the last complete record the UI has applied, even a partially delivered synchronization advances the browser's cursor, so each retry replays strictly less history and reconnect loops terminate.

This exemption deliberately trades transient per-connection memory — up to one serialized copy of the replayed history in the socket buffer for a slow client — for guaranteed termination; the earlier close-on-overflow rule recreated the identical oversized batch on every retry and never converged. Session size is bounded in practice by Pi's context and compaction scale, and the database-first loading flow keeps the usual replay window small. Revisit with chunked synchronization only if this becomes a measured problem.

If `afterRecordId` is unknown, synchronization selects `mode: "full"` and replays all complete records. The UI upserts replayed records by ID.

There is deliberately no separate snapshot payload. Synchronization expresses the current operation as the same events used for live updates, with `replace` patches where complete accumulated state is needed. This keeps one reducer and one event model. `sync.started` tells the browser to clear transient state before applying the reconstructing events.

This provides reconnect without retaining a token-delta replay log. The resume cursor is a durable history record ID, while replayed ordinary events reconstruct transient work.

### 6.3 Frame union

Keep the top-level union small. The browser sends only a hello or a request. Steering and queued follow-ups are deferred beyond the first slice; when added, they become new delivery variants inside the message action, guarded by capability values.

```ts
type ClientFrame = ClientHello | ClientRequest;

type MessageInputBlock =
  | { type: "text"; text: string }
  | {
      /** Capability `input.image`; base64 payload without a data-URL prefix. */
      type: "image";
      mediaType: string;
      data: string;
    };

type ClientAction =
  | {
      type: "message";
      expectedHeadId: string | null;
      content: MessageInputBlock[];
    }
  | {
      type: "abort";
      operationId: string;
    };

interface ClientRequest {
  v: 1;
  type: "client.request";
  requestId: string;
  action: ClientAction;
}

type ServerFrame =
  | ServerWelcome
  | SyncStartedFrame
  | HistoryRecordFrame
  | RuntimeEventFrame
  | SyncCompletedFrame
  | RequestResultFrame
  | ServerErrorFrame;
```

`expectedHeadId` prevents a stale tab from silently starting a turn against a different conversation head. Requiring an operation ID prevents a delayed abort from affecting a later operation. An operation is one continuous busy period from an accepted new message until the runtime returns to idle. When steering and follow-ups are added in a later slice, they will join the operation they target rather than starting new ones.

A request receives exactly one requester-only result:

```ts
interface RequestResultFrame {
  v: 1;
  type: "request.result";
  at: string;
  requestId: string;
  result:
    | { type: "accepted"; operationId: string; duplicate: boolean }
    | {
        type: "rejected";
        error: {
          code:
            | "invalid_request"
            | "unsupported"
            | "busy"
            | "stale_head"
            | "stale_operation"
            | "request_id_conflict"
            | "internal";
          message: string;
          retryable: boolean;
        };
      };
}
```

Acceptance is not operation completion. State changes are broadcast to every connected browser as a single event envelope:

```ts
interface RuntimeEventFrame {
  v: 1;
  type: "runtime.event";
  at: string;
  event:
    | RuntimeStatusEvent
    | OperationStartedEvent
    | OutputPatchEvent
    | ToolStateEvent
    | OperationFinishedEvent;
}

interface OutputPatchEvent {
  type: "output_patch";
  operationId: string;
  blockId: string;
  blockType: "text" | "reasoning";
  revision: number;
  patch: { type: "append"; text: string } | { type: "replace"; text: string };
}

interface ToolStateEvent {
  type: "tool_state";
  operationId: string;
  callId: string;
  name: string;
  revision: number;
  state: "running" | "completed" | "failed";
  message?: string;
  data?: JsonValue;
}
```

Complete records use `history.record` both during synchronization and live operation. They improve UI responsiveness, but the control plane ignores them for persistence. A successful `operation_finished` event is sent only after all complete history records caused by that operation have been emitted.

No application-level ping frame is needed. The runtime and proxy use WebSocket protocol ping/pong for dead-peer detection; browsers respond to protocol pings automatically. Runtime status/health remains ordinary state, not a ping substitute.

All schemas will be closed TypeBox schemas. An invalid request receives a rejected `request.result` where its request ID can be recovered, otherwise `server.error`. A v1 browser should ignore a well-formed unknown server event so optional capabilities can be added without breaking old clients.

### 6.4 Ordering, request identity, and backpressure

WebSocket ordering is sufficient within one connection, so frames do not have an event sequence number. Synchronous hello preparation creates the synchronization boundary. Reconnection uses complete record IDs and reconstructed live events, not a socket event offset.

`client.hello` is non-mutating: it observes and synchronizes state. Both request actions are mutating: `message` starts agent work, and `abort` changes a running operation. HTTP health and history pulls are also non-mutating from the runtime's perspective. Control-plane host start/stop operations are mutations in a different API.

Request identity is in-memory and scoped to one runtime process. The runtime keeps a map from request ID to its action and outcome for the life of the process. Resending a known request ID with an identical action returns the original result with `duplicate: true`; reusing a known ID with a different action returns `request_id_conflict`; an abort naming a finished or unknown operation returns `stale_operation`.

A runtime restart empties that map, and `server.welcome.runtimeInstanceId` tells the browser so. After reconnecting, the browser may automatically resend an unacknowledged request only when `runtimeInstanceId` matches the instance that received it. When the instance has changed, the browser relies on synchronization instead: the Pi adapter uses `AgentSession.sendUserMessage`, and Pi appends an accepted user message to the session on its awaited `message_end`, before model streaming begins, so a delivered message always appears in the replayed history. If it appears, the request was delivered; if it does not, it never reached the model, and the user decides whether to send it again as a new request.

There is deliberately no durable request inbox. An earlier proposal appended a `pi-orb.request` custom marker entry to Pi's session ledger before each mutating action so that unacknowledged requests could be resumed exactly-once across runtime restarts. It was rejected as disproportionate: the shutdown model already accepts losing an in-flight turn, the markers doubled the persisted records per send and moved the conversation head onto hidden entries, and the residual risk — a blind resend across a runtime restart — is prevented by the instance-ID rule above. A future harness adapter therefore needs no durable request marker or correlation mechanism; it only needs a stable per-process runtime instance ID.

Under outbound pressure, transient output and tool-state events may be coalesced to their newest equivalent state. Welcome, synchronization boundaries, request results, complete history records, operation transitions, and errors are never intentionally dropped. If critical queued data exceeds the configured budget, the runtime closes the connection and the browser reconstructs state through a new handshake.

Harness capabilities differ. `server.welcome.capabilities` initially advertises values such as `abort` and `input.image`; later slices can add `steer` and `follow_up` behind new capability values without a wire-version change. Unsupported actions are rejected explicitly.

`input.image` is implemented end to end (2026-08-01): the browser composer accepts pasted images and sends them as `image` input blocks, the runtime forwards them to Pi's `sendUserMessage` as native image content (`mediaType` → Pi's `mimeType`), and they replicate losslessly through the ordinary history path like any other Pi-persisted content. To accommodate base64 payloads, the runtime's limits are 8 MiB per incoming frame and 6 MiB per prompt (`server.welcome.limits` remains authoritative for clients; the browser enforces the limit at paste time).

### 6.5 Multiple connections

Naturally support multiple simultaneous WebSocket connections to one orb. Each connection performs its own cursor-based synchronization and has its own bounded outbound writer. Complete history, runtime events, and status are broadcast; `request.result` is sent only to the requester.

All mutating requests from all connections pass through one runtime serial executor. `expectedHeadId`, operation IDs, and request IDs make races explicit: for example, two new-message requests against the same head cannot both succeed. This is not a commitment to multiplayer product features—there is no presence, attribution, shared editor state, or per-user permission model—but browser reloads and multiple tabs do not evict each other.

If a later deployment needs a single-connection policy, enforce it in the runtime rather than the control plane: atomically replace the active connection on a successful new hello and close the previous socket with a private replacement close code. Runtime enforcement works even with multiple control-plane instances. The first slice does not impose this restriction.

## 7. Harness-agnostic history model

### 7.1 Principles

- Statically type semantics common to Pi, Claude Code, and Codex.
- Preserve the complete native harness record losslessly.
- Use stable record IDs and parent IDs to support a future tree.
- Do not put conversation-order sequence numbers in the public history model.
- Model mixed message content as typed blocks because a single assistant message can interleave text, reasoning, images, and tool calls.
- Treat compaction as an additive history record, not deletion.

### 7.2 Proposed types

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface HarnessSessionMetadata {
  id: string;
  timestamp?: string;

  /** Complete native session header/metadata. */
  overflow: Record<string, JsonValue>;
}

interface HistoryRecordBase {
  id: string;
  parentId: string | null;
  timestamp: string;

  /**
   * Contains the complete original harness record and any data not
   * represented by normalized fields. This intentionally duplicates
   * some normalized data to guarantee losslessness.
   */
  overflow: Record<string, JsonValue>;
}

type MessageRole = "user" | "assistant" | "system" | "developer" | "tool";

type ContentBlock =
  | {
      type: "text";
      text: string;
      overflow?: Record<string, JsonValue>;
    }
  | {
      type: "reasoning";
      text: string;
      redacted?: boolean;
      overflow?: Record<string, JsonValue>;
    }
  | {
      type: "image";
      mediaType?: string;
      data?: string;
      url?: string;
      overflow?: Record<string, JsonValue>;
    }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      arguments: JsonValue;
      overflow?: Record<string, JsonValue>;
    }
  | {
      type: "tool_result";
      callId: string;
      content: ContentBlock[];
      isError?: boolean;
      overflow?: Record<string, JsonValue>;
    }
  | {
      type: "other";
      contentType: string;
      data: JsonValue;
    };

interface MessageRecord extends HistoryRecordBase {
  type: "message";
  role?: MessageRole;
  content: ContentBlock[];

  model?: {
    provider?: string;
    id: string;
  };

  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };

  finishReason?: string;
}

interface CompactionRecord extends HistoryRecordBase {
  type: "compaction";
  summary: ContentBlock[];
}

interface EventRecord extends HistoryRecordBase {
  type: "event";
  eventType: string;
  content?: ContentBlock[];
}

type HistoryRecord = MessageRecord | CompactionRecord | EventRecord;
```

This is a proposal, not a frozen schema. In particular, configuration/model-change records, attachments, patches, and command execution may deserve additional typed variants after comparing real Pi, Claude Code, and Codex histories.

### 7.3 Tree state

`id` and `parentId` describe graph ancestry. They do not identify which leaf is currently active once branching exists. The replica therefore also needs an independently replicated `headId`.

The first version remains linear, so `headId` is normally the latest record. Keeping it explicit avoids a future schema migration when trees are enabled.

## 8. Correct history replication

History replication is a correctness-critical subsystem. Tool calls, tool results, reasoning where persisted, compactions, model changes, extension/custom entries, and any other harness-persisted data must not silently disappear.

### 8.1 Pull-only model and cursor ownership

The first version uses pull-only replication. The control plane polls every active orb approximately every 10 seconds and asks for complete history records after its last committed cursor.

There is one cursor per orb:

- The **control plane** stores the ID of the last record it committed.
- The **runtime** uses the harness's persisted append order to return complete records after that ID.
- The **browser** does not use this cursor to define conversation-tree order.
- History rows are keyed by stable record ID and parent ID.

Use the harness's native record ID whenever it provides one. Pi session entries already have stable IDs. An adapter may generate a stable ID only when a harness provides none; it must not replace an available native ID.

The first-slice endpoint is an idempotent GET:

```http
GET /v1/history?after=<record-id>&limit=100
```

Omit `after` to read from the beginning. `limit` is optional and defaults to 100; values outside `1..500` are rejected.

```ts
type HistoryCursor = string; // The last returned native harness record ID.

interface PullHistoryResponse {
  v: 1;
  orbId: string;
  runtimeInstanceId: string;
  activity: "idle" | "busy";
  session: HarnessSessionMetadata;
  records: HistoryRecord[];

  /** Equal to `after` when records is empty; otherwise the final record ID. */
  cursor: HistoryCursor | null;

  /** Active head represented after applying exactly this returned prefix. */
  headId: string | null;
}
```

There is deliberately no `hasMore`, snapshot token, sequence number, or source-head field. A non-empty response tells the control plane to commit and pull again immediately. An empty response means it was caught up at that request's snapshot instant.

Required endpoint semantics:

- At the start of each request, the runtime synchronously captures one immutable view of the harness's persisted entries. Records appended afterward belong to the next request.
- Only complete, durably persisted harness records may be returned. Partial assistant output that the LLM is still streaming is absent from Pi's `SessionManager.getEntries()` and must not be synthesized into this endpoint.
- Every persisted harness entry after `after`, including hidden custom entries, maps one-to-one to a `HistoryRecord`; the adapter must not skip entries that would break cursor continuity.
- Records are returned in harness append order, which is necessarily parent-before-child order. A child arriving before its parent is therefore impossible from a correct adapter; the deferred foreign key makes any violation fail the commit transaction as a replication-integrity error rather than something to reorder around.
- If at least one complete record exists after `after`, return between one and `limit` records.
- `cursor` is the ID of the final returned record, or exactly the requested `after` when the response is empty.
- `headId` is the active head represented by the returned prefix, not a newer runtime head beyond a partial batch. It is therefore always null or references a record already present in this response or an earlier committed prefix.
- Repeating the same request against unchanged history returns stable IDs and content.
- An unknown non-null `after` returns HTTP `409` with typed code `cursor_not_found`; persistence never silently resets to a full replay.
- Malformed query parameters return `400`; a temporarily unavailable history source returns `503` with a typed retryable error.

Errors use one small shape:

```ts
interface RuntimeHttpError {
  v: 1;
  error: {
    code: "invalid_request" | "cursor_not_found" | "history_unavailable";
    message: string;
    retryable: boolean;
  };
}
```

`orbId` detects host-routing mistakes. `runtimeInstanceId` and `activity` let the pull double as the running-orb liveness and activity signal; `GET /v1/health` remains for startup readiness, restart checks, and diagnostics. `session.id` is Pi's session UUID and prevents records from a replacement session being merged into the same orb replica. The session header is metadata rather than a history record, so it never changes the cursor or entry ancestry. The first successful pull stores the complete metadata on the orb row; every later pull must match it exactly. A mismatch is a non-retryable replication-integrity failure: the control plane never merges records from a different session and never silently resets the replica; it stops the host (no drain could succeed) and marks the orb `failed` with a typed error.

The control plane commits each non-empty response transactionally: verify immutable session metadata and duplicate rows, insert new records, update `replicated_head_id`, and advance `replication_cursor` with cursor compare-and-swap. An empty response may still initialize/verify session metadata, but does not advance the cursor. If the transaction fails, the cursor does not advance and the next poll requests the same range again.

No cursor is stored inside every history record, and Pi does not need a separate runtime outbox or replication journal. Its authoritative session history already provides the durable records and append order needed by the pull adapter.

### 8.2 Polling and retries

The control plane is solely responsible for scheduling persistence work:

- poll every active orb at roughly a 10-second interval;
- treat a successful pull as the running-orb liveness/activity signal; pull failures persisting past the 30-second grace period trigger the unreachable-runtime restart rule of the lifecycle section (this proxy is no weaker than the health poll it replaced — either one proves only that the runtime process serves HTTP; live WebSocket health is observed by the proxy connection itself);
- after a non-empty response, it may pull again immediately to reduce lag;
- retry runtime, network, and database failures from the unchanged committed cursor at the ordinary polling cadence — no separate backoff schedule or retry state is needed in the first slice;
- use an optimistic cursor compare-and-swap so overlapping pollers cannot advance the same orb cursor incorrectly;
- use transactional idempotency so worker crashes and repeated pulls are harmless.

Each poll remembers the database cursor `C` used in its runtime request. Its commit transaction inserts/upserts the returned records and advances the cursor only if the database cursor is still `C`. If another poller advanced it first, the conditional update affects no row, the transaction is rolled back/discarded, and the losing poller starts again from the new cursor. No lease or lock is held while making the runtime request.

In cloud deployment, at least one Cloud Run instance remains provisioned with CPU allocated outside request handling, allowing an in-process polling loop to run continuously. The loop must recover entirely from PostgreSQL after instance replacement. If the service scales beyond one instance, redundant pollers are allowed; the database cursor compare-and-swap makes their commits safe without leader election or a polling lease.

### 8.3 Database-first history loading and content-agnostic live handoff

Opening an active orb should behave as follows:

1. The UI requests history from the control plane.
2. In one consistent database read, the control plane returns all replicated records, `headId`, and cursor `C`.
3. The control plane resolves or starts the host while the UI renders database history immediately.
4. The browser opens a live connection to the control plane and sends `C` in `client.hello`.
5. The control plane routes the unauthenticated first-slice connection and acts as a content-agnostic proxy for data frames.
6. The runtime replays complete records and reconstructing live events after `C`, then continues with new live output.
7. Stable IDs let the browser deduplicate records that cross the database/live boundary.

The browser may see live content and committed-record notifications before the next persistence poll. The control plane does not inspect those WebSocket frames for persistence and does not optimistically insert submitted user messages—or any other proxied content—into the replica. User messages and all other records enter the replica only when the regular HTTP pull path returns the harness-persisted record.

“Content-agnostic” does not mean blind TCP forwarding: the control plane still owns host startup, routing, connection limits, and protocol-version negotiation. Authentication and authorization will also belong at this boundary when added after the first slice. The control plane does not interpret runtime application frames after handoff, with exactly two idle-auto-stop carve-outs on the browser→runtime direction (§3.4): `client.presence` frames are consumed by the proxy (the runtime has no use for tab visibility, though it ignores one defensively), and a `client.request` sniff refreshes the advisory `last_busy_at` before the frame is forwarded unchanged. Runtime→browser frames are never parsed.

### 8.4 Controlled shutdown pull barrier

Shutdown does not wait for Pi to settle. The requesting user or parent agent accepts the risk of interrupting active work.

Before stopping the host, the control plane:

1. pulls after its current committed cursor;
2. commits the response and advances the cursor atomically;
3. repeats while each pull returns one or more records;
4. when a pull returns no new complete records, immediately requests host stop.

If a pull or database commit fails retryably, the stop does not proceed; the control plane retries while leaving the host running.

Drain failures are classified. Transport failures, `503 history_unavailable`, and transient database errors are retryable. `409 cursor_not_found`, a session-header mismatch, and mapping/validation failures are replication-integrity failures that no retry can repair. On an integrity failure the control plane abandons the drain, stops the host, and marks the orb `failed` with a typed error naming the problem: blocking the stop forever cannot make the replica complete and would strand the orb, while the authoritative filesystem still holds every complete record for a future reconciliation mechanism (see open questions) to repair the replica.

The lifecycle rules add the remaining exceptions to the pull-until-empty barrier: an orb that never reached ready and has no session skips the drain entirely, and an absent or already-stopped host cannot be drained and is marked `stopped` directly, accepting the replication caveat stated in the persistence decisions. Recovery from an integrity-`failed` orb is manual by decision — inspect the filesystem, repair or abandon the replica — and stays manual until the system is demonstrably stable; automated ID-based reconciliation is deliberately not planned for the early slices. A later start of such an orb will hit the same integrity error and return to `failed` rather than corrupting the replica.

An in-progress record is intentionally omitted. If shutdown terminates the process before that record becomes complete, it is not replicated; this is part of the caller-accepted interruption risk. A complete record committed in the narrow race after the final empty pull and before process termination remains on the authoritative filesystem and will be discovered after the next start.

### 8.5 Reconciliation and failure model

The filesystem is assumed to survive process, container, VM, and Spot failures. After restart, polling resumes from the database cursor and discovers remaining complete harness records.

For Pi, the adapter can enumerate every persisted entry. A full ID-based reconciliation endpoint or diagnostic mode may become useful as a backstop if the stored cursor is invalid or the adapter/session disagree, but it is not required to reconstruct the orb, and by decision all such repair remains manual until the system is demonstrably stable.

The replica is explicitly **not** an orb backup or reconstruction source. If orb deletion is added later, replicated history may remain browsable according to retention policy, but that history is not used to recreate a deleted filesystem or resume the Pi session.

**Field finding (2026-08-03) — first real `cursor_not_found` integrity failure (investigation ongoing).** An orb failed with `replication_integrity: cursor_not_found: unknown cursor 157ac990` on its second start. Established by evidence (Postgres replica, GCE operation log, pinned-SDK source):

- The cursor record is real and replicated: a `thinking_level_change` session-init event appended 19:40:41Z during the orb's only active session (the full replica is two init events; no user messages). It was appended 15 minutes before a clean, drained idle stop — durably on disk, so tail-loss-in-page-cache is ruled out *for this incident*.
- Script repair is ruled out: the orb was created after the deploy; no `setMetadata` ever ran on the VM. Both disks are the originals, attached throughout.
- The SDK reuses the session file in place on `open()` and `getEntries()` returns all file entries — a boot that opened the original file would have known the cursor.
- **Root cause (proven 2026-08-04 by disk forensics — snapshot of the data disk inspected on a scratch VM).** `pi-sessions/` on the persistent disk is *empty*, and its mtime predates the replicated records: no session file was ever written. The pinned SDK's `SessionManager._persist` deliberately **does not write the session file until the first assistant message exists** — a session holding only the header and init events (`model_change`, `thinking_level_change`) stays entirely in memory, by design. This orb never received an assistant reply, so its session was never persisted; pi-orb's snapshot serves `getEntries()` (the in-memory list), so the control plane replicated those init events and committed one as its cursor. The idle stop discarded the container and with it the only copy; the next boot found an empty `pi-sessions/`, silently created a fresh session, and the first pull's cursor was unknown. **Every orb that stops before its first assistant reply is guaranteed to hit this**; orbs that have ever produced an assistant message are flushed and safe — which is why routine stop/starts had worked before.
- Also observed in the same forensics: the data-disk filesystem carried a dirty ext4 journal — GCE instance stops are effectively power-cuts for this mount (the COS shutdown does not cleanly unmount it), which keeps the fsync half of open question 33 live even after this bug is fixed.

**Fix implemented (2026-08-04): the replication flush gate.** The snapshot served to the control plane's history pull (`replicationSnapshot`, composing `gateUnflushedSnapshot` with `sessionFlushed` in `pi/session-flush.ts`) serves zero records and a null head while the SDK has not written the session file; `sessionFlushed` observes file existence rather than mirroring the SDK's internal first-assistant-message heuristic, so the gate degrades to a no-op if a future SDK flushes eagerly. The replica therefore stays empty until the first flush, and a committed cursor can only ever name a durably-persisted entry. **The gate applies to the replication pull only.** Every browser-facing view — connect-time sync, the live record publisher, and the request gate's head — stays ungated: the browser path is upsert-based and full-resyncs on an unknown cursor by design, and (learned the hard way on the first deploy of this fix) gating only part of the browser-facing surface desynchronizes the head the client sees from the head its requests are validated against, rejecting every first message with `stale_head`. The SDK's lazy-flush behavior and id stability across reopen are pinned in `session-flush.contract.test.ts`; the stop-before-first-reply restart shape is covered in lifecycle DST (`empty-history-restart`). Forcing the SDK to flush eagerly was rejected: it requires mutating two private SessionManager members in exactly the right order (`_rewriteFile` plus the `flushed` flag, whose interplay with the SDK's own `wx`-mode flush would otherwise throw) — a public `eagerPersist` option upstream remains the cleaner long-term alternative. Remaining gaps regardless: (a) startup script should abort when the data-disk mount fails rather than bind-mounting an empty directory; (b) an operator replication-reset as the recovery escape hatch (recovery today is a new orb); (c) open question 33's fsync/truncated-tail hardening. The §8.1 rule itself worked as designed: loud `failed`, no silent rewind.

### 8.6 Minimal PostgreSQL schema

The first slice uses three tables only: `projects`, `orbs`, and `history_records`. Replication state lives on the orb row. Do not add user/auth, live-event, command, polling-job, host-resource, audit, or request-claim tables.

Application code generates UUIDs with Node's `crypto.randomUUID()`; PostgreSQL does not need a UUID extension.

```sql
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  repository_url text NOT NULL CHECK (btrim(repository_url) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orbs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),

  state text NOT NULL CHECK (state IN (
    'creating', 'starting', 'running', 'stopping', 'stopped', 'failed'
  )),
  state_version bigint NOT NULL DEFAULT 0,

  host_kind text NOT NULL,
  host_ref text,
  checkout_commit text,
  harness_session_id text,
  harness_session_header jsonb CHECK (
    harness_session_header IS NULL OR jsonb_typeof(harness_session_header) = 'object'
  ),
  CHECK ((harness_session_id IS NULL) = (harness_session_header IS NULL)),
  CHECK (
    harness_session_header IS NULL OR harness_session_header->>'id' = harness_session_id
  ),
  last_error text,

  replication_cursor text,
  replicated_head_id text,

  state_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orbs_project_id_idx ON orbs(project_id);
CREATE INDEX orbs_state_idx ON orbs(state);

CREATE TABLE history_records (
  orb_id uuid NOT NULL REFERENCES orbs(id),
  record_id text NOT NULL,
  parent_id text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  inserted_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (orb_id, record_id),
  FOREIGN KEY (orb_id, parent_id)
    REFERENCES history_records(orb_id, record_id)
    DEFERRABLE INITIALLY DEFERRED,

  CHECK (record->>'id' = record_id),
  CHECK ((record->>'parentId') IS NOT DISTINCT FROM parent_id)
);

CREATE INDEX history_records_parent_idx
  ON history_records(orb_id, parent_id);

ALTER TABLE orbs ADD CONSTRAINT orbs_replication_cursor_fk
  FOREIGN KEY (id, replication_cursor)
  REFERENCES history_records(orb_id, record_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE orbs ADD CONSTRAINT orbs_replicated_head_fk
  FOREIGN KEY (id, replicated_head_id)
  REFERENCES history_records(orb_id, record_id)
  DEFERRABLE INITIALLY DEFERRED;
```

`history_records.record` stores the complete normalized `HistoryRecord`, including its lossless native `overflow`. The few duplicated columns exist only for keys and tree traversal. There is deliberately no database conversation sequence number: linear order is reconstructed by following `parent_id` from `replicated_head_id`, and future branching uses the same graph.

`replicated_head_id` means the latest active head whose record is present in the replica. A runtime pull may report a source head beyond a partial batch; do not expose/store that as the replicated head until the referenced record has been committed. `replication_cursor` always references the final committed record in append order and is independent of tree order.

History records are immutable by ID. A repeated pull may encounter an existing `(orb_id, record_id)` only if the stored `parent_id` and JSON value are identical; differing content is a replication-integrity error, not an update.

The pull commit remains one explicit transaction:

```sql
BEGIN;

-- Insert each record. Identical existing rows are accepted; conflicting rows fail.

UPDATE orbs
SET replication_cursor = $next_cursor,
    replicated_head_id = $next_replicated_head,
    updated_at = now()
WHERE id = $orb_id
  AND replication_cursor IS NOT DISTINCT FROM $expected_cursor;

-- Zero updated rows means another poller won: ROLLBACK and repoll.
COMMIT;
```

Lifecycle transitions use `state_version` compare-and-swap, increment it, and update `state_changed_at`. Replication updates change neither `state_version` nor `state_changed_at`, and lifecycle updates do not change replication fields, so the two correctness checks remain logically independent even though PostgreSQL may briefly serialize writes to the same orb row.

Keep the first migration as one hand-written `001_initial.sql`. The `pg` adapter executes migrations and repository operations with explicit `BEGIN`/`COMMIT`/`ROLLBACK`, wrapping every driver call in `ResultAsync.fromThrowable`.

## 9. Pi history behavior

Pi session files are append-only JSONL trees. Each entry has an `id` and `parentId`; the session header is separate.

Pi compaction does not delete earlier entries. It appends a `compaction` entry containing a summary and information about the retained context boundary.

The embedded runtime can access complete persisted history through the retained `SessionManager`:

```ts
sessionManager.getHeader(); // session metadata
sessionManager.getEntries(); // all entries, including pre-compaction
sessionManager.getTree(); // full tree, including abandoned branches
```

The following APIs are model-context views and must not be used as the replication source:

```ts
sessionManager.buildContextEntries();
sessionManager.buildSessionContext();
```

They intentionally apply compaction and active-branch selection. Similarly, model-facing `session.messages` is not the lossless full session log.

Therefore:

- the Pi runtime/SDK can read and replicate full pre-compaction history;
- the LLM itself does not automatically receive that full history after compaction;
- a future history-query tool could let the model explicitly retrieve older records if desired.

### 9.1 Session metadata

The Pi `SessionHeader` is not a `HistoryRecord`. It has no entry parent and does not participate in Pi's entry tree. Map it to `HarnessSessionMetadata`:

```ts
{
  id: header.id,
  timestamp: header.timestamp,
  overflow: { native: header }
}
```

Store its complete JSON in `orbs.harness_session_header` and its ID in `harness_session_id`. It never advances the history cursor and never becomes an invented root parent. Repeated pulls require JSON-semantic equality with the stored header.

### 9.2 Entry mapping

For every entry, preserve `entry.id`, `entry.parentId`, and `entry.timestamp` exactly and put the complete JSON-safe original in `overflow.native`. Normalized fields intentionally duplicate native data.

| Pi persisted entry         | Normalized record                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `message` / user           | `MessageRecord`, role `user`; text/image blocks.                                                                                |
| `message` / assistant      | `MessageRecord`, role `assistant`; text, thinking→reasoning, and tool-call blocks; provider/model, usage, stop reason.          |
| `message` / tool result    | `MessageRecord`, role `tool`; one typed `tool_result` block containing call ID, nested text/image content, and error flag.      |
| `message` / bash execution | `EventRecord`, `eventType: "pi.bash_execution"`; normalized textual content where useful.                                       |
| `thinking_level_change`    | `EventRecord`, `eventType: "pi.thinking_level_change"`.                                                                         |
| `model_change`             | `EventRecord`, `eventType: "pi.model_change"`.                                                                                  |
| `compaction`               | `CompactionRecord`; summary as a text block, with first-kept ID/token/details retained natively.                                |
| `branch_summary`           | `EventRecord`, `eventType: "pi.branch_summary"`, with summary text content.                                                     |
| `custom`                   | `EventRecord`, `eventType: "pi.custom"`.                                                                                        |
| `custom_message`           | `EventRecord`, `eventType: "pi.custom_message"`, with text/image content; retain `customType`, `display`, and details natively. |
| `label`                    | `EventRecord`, `eventType: "pi.label"`.                                                                                         |
| `session_info`             | `EventRecord`, `eventType: "pi.session_info"`.                                                                                  |
| unknown future entry       | `EventRecord`, `eventType: "pi.<native-type>"`.                                                                                 |

Content conversions are direct and lossless through native overflow:

- Pi text → `ContentBlock { type: "text" }`;
- Pi image `mimeType`/base64 data → normalized `mediaType`/data;
- Pi thinking text → `ContentBlock { type: "reasoning" }`;
- Pi tool call ID/name/arguments → typed `tool_call`;
- Pi tool-result call ID/content/error → typed `tool_result`;
- assistant provider/model/usage/cost/stop reason → normalized model, usage, and `finishReason` fields.

An unknown message role maps to a generic event rather than inventing a shared role. A mapping/validation failure returns a typed history error and makes `pullHistory` fail; it must never silently omit an entry.

### 9.3 Completeness and cursor continuity

`SessionManager.getEntries()` is the sole Pi replication source. Pi appends user/tool/assistant messages on awaited `message_end`; streaming `message_update` state is not present there and is never synthesized into persistence. Pi's `AgentSession` notifies SDK subscribers of `message_end` immediately before it appends the ordinary message entry, and its `entry_appended` event covers extension-created custom entries rather than ordinary messages. The adapter therefore schedules a session-entry scan after each `message_end`, deduplicates by native entry ID, and performs a final synchronous scan at `agent_settled` before emitting `operation_finished` and clearing transient output. Adapter tests reproduce this exact notify-then-append ordering; mapping-only tests are insufficient to verify live-history delivery.

Every returned persisted entry maps one-to-one to exactly one record and advances the native-ID cursor exactly once. This includes labels and hidden custom entries. Unknown future types still become generic events, preserving cursor continuity across Pi upgrades.

### 9.4 Initial UI visibility

Visibility is presentation policy, not persistence filtering:

- show user and assistant messages normally; show tool names and states while keeping tool inputs and outputs collapsed by default;
- show compaction as a collapsed boundary;
- show `pi.custom_message` only when native `display` is true;
- hide model/thinking changes, branch summaries, bash-execution events, labels, session-info entries, ordinary custom entries, and unknown events by default.

The UI still traverses hidden records when reconstructing parent chains. Hidden records remain available for diagnostics and future richer renderers.

## 10. Web UI behavior

The UI must support two modes without visibly changing data sources:

- **Stopped/unavailable orb:** show the complete replicated history from the control plane database.
- **Active orb:** first show database history, then attach live updates after the database cursor while the host may still be starting.

The first UI needs to display at least:

- user text as plain text and assistant text as Markdown, for both committed history and live streaming;
- reasoning/thinking when available and permitted;
- tool-call and tool-result status, with inputs and outputs available only through collapsed disclosures by default;
- compaction summaries;
- runtime state such as starting, working, idle, stopped, or failed.

Remaining UI questions include rendering unknown content blocks, large/truncated tool output, and image storage. Transient token deltas are ephemeral presentation events and are reconstructed after reconnect through ordinary live events; they are not stored in PostgreSQL.

### 10.1 Visual design (decided)

The UI uses the "Reading Room" variant of the Manuscript × Gutter design, chosen from a design exploration (five initial directions, then a Manuscript × Gutter hybrid, then five typography variations). Decisions:

- **Paper/ink palette, light mode only.** Warm paper ground (`#f8f3e9`), ink text (`#221c12`), terracotta accent (`#a03e1c`). No dark mode — explicit product decision.
- **Reading typography.** Agent prose is set in a Charter/Iowan Old Style serif stack at 17.5px/1.7; user messages are larger italic serif "margin notes" on terracotta blocks; headings and buttons use small-caps serif; structural meta (labels, chips, tool output, orb ids) is quiet monospace. All fonts are system stacks — no webfonts.
- **Turn gutter.** Every chat turn carries a gutter column: a marked square (`Y` filled terracotta for the user, `O` outlined ink for the agent) with a fading vertical rail. Adjacent agent-side records (assistant, tool results, displayed events) group into a single agent turn; compaction renders as a full-width dashed divider crossing the gutter.
- **Fluid width.** No max-width constraint — the manuscript fills the window at any size.
- **Composer.** Sticky at the viewport bottom, full-bleed; serif input, round ink send button (`↑`, ⌘⏎ shortcut), small-caps terracotta abort in the same row; chat scrolls in the normal document flow with bottom-pinned auto-follow (§ scroll pinning in `apps/web/src/lib/scroll-pin.ts`).

## 11. Projects, source checkout, and first end-to-end slice

### 11.1 Project model

The first version is fully web-driven and does not require a local checkout or CLI.

A user registers a project in the web UI with:

- a project name;
- a public Git repository URL.

Starting an orb for the project performs a fresh clone into the orb filesystem. There is no local upload, dirty-state patch, sync-back workflow, clone cache, prepared snapshot, or other checkout optimization initially. The initial clone uses the repository's default branch; the resolved commit should be recorded for observability.

Repository URL validation is strict allowlisting, decided as follows:

- the scheme must be exactly `https`, and `GIT_ALLOW_PROTOCOL=https` is set for the clone so redirects cannot switch protocols;
- the hostname must be on a fixed allowlist, initially `github.com`, `gitlab.com`, `bitbucket.org`, and `codeberg.org`; extending the list is configuration, not a design change;
- userinfo (credential-bearing URLs), explicit ports, and IP-literal hosts are rejected;
- the path must match the host's repository shape (for example `/{owner}/{repo}` with an optional `.git`);
- validation runs at project creation and is re-run by the runtime immediately before cloning, because the first slice's database is writable by anyone who can reach the control plane.

This forecloses local paths, `file://` URLs, credential leakage into the database and logs, and SSRF against internal networks or cloud metadata endpoints.

The environment is prescribed initially:

- Debian 12 (the runtime container image's base);
- Node.js 24;
- fixed orb runtime/container image on every provider;
- Spot `n2d-highmem-4` Container-Optimized OS VMs on GCE later, running that same container image;
- no required orb configuration for a simple TypeScript project.

Still open:

- whether users can choose a branch or revision after the first slice;
- whether and when to add an Orbfile;
- whether to adopt conventional setup/restart hooks before introducing a general configuration format;
- how prebuilt project environments or snapshots are keyed and invalidated later.

### 11.2 First end-to-end success case

The first vertical slice should demonstrate:

1. In the web UI, add a project with a name and public Git URL.
2. Start an orb for that project.
3. The configured `OrbHostProvider` creates an isolated persistent filesystem and runtime host; the first implementation does so with a Docker volume and container.
4. The runtime clones the repository and starts one embedded Pi session in it.
5. Send a prompt from the browser through the control plane.
6. Display assistant text, tool calls, tool results, and errors in the web UI.
7. The control plane periodically pulls complete Pi history records and persists them transactionally in PostgreSQL while live output continues.
8. Request orb stop; the control plane drains pulls until one returns no new complete records, then stops without waiting for Pi to settle.
9. Reopen the orb page and render database history immediately while the container starts.
10. Hand the browser connection to the runtime through the content-agnostic proxy and continue without duplicates or gaps.
11. Deterministically simulate temporary runtime/database failures, repeated pulls, worker crashes, concurrent pollers, and shutdown races, asserting idempotent and gap-free persistence.

“Deterministically simulate failures” means testing the replication state machine with `determined`: for example, a database transaction fails, so the stored cursor must remain unchanged and the next poll must safely return and commit the same stable record IDs. It does not mean injecting failures into the manual browser demo itself.

### 11.3 Minimal control-plane API

The browser uses a small unauthenticated JSON API under `/api/v1`:

```text
GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/:projectId

GET  /api/v1/projects/:projectId/orbs
POST /api/v1/projects/:projectId/orbs
GET  /api/v1/orbs/:orbId
POST /api/v1/orbs/:orbId/start
POST /api/v1/orbs/:orbId/stop

GET  /api/v1/orbs/:orbId/history
WS   /api/v1/orbs/:orbId/live
```

There are no project/orb update/delete, credential, model-selection, admin, or generic host-operation endpoints in the first slice. OAuth is an internal prerequisite of orb creation/start, not a standalone frontend resource.

The browser generates project and orb UUIDs with `crypto.randomUUID()` and includes them in create requests:

```ts
interface CreateProjectRequest {
  id: string;
  name: string;
  repositoryUrl: string;
}

interface CreateOrbRequest {
  id: string;
}
```

This makes a retried create naturally idempotent without an idempotency table: the same ID and identical body returns the existing resource, while the same ID with different content returns `409 conflict`. Creating an orb also requests its initial start and returns it in `creating` state.

```ts
interface ProjectView {
  id: string;
  name: string;
  repositoryUrl: string;
  createdAt: string;
}

interface OrbView {
  id: string;
  projectId: string;
  state: "creating" | "starting" | "running" | "stopping" | "stopped" | "failed";
  stateVersion: number;
  checkoutCommit?: string;
  lastError?: string;
  stateDetail?: {
    type: "draining_history";
    retrying: boolean;
    message?: string;
  };
  stateChangedAt: string;
  actionRequired?: {
    type: "openai_codex_device_login";
    verificationUri: string;
    userCode: string;
    expiresAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface OrbHistoryView {
  orbId: string;
  session: HarnessSessionMetadata | null;
  cursor: string | null;
  headId: string | null;
  records: HistoryRecord[];
}
```

Do not expose `host_ref`, model credentials, harness session ID, or internal replication fields in `OrbView`. `actionRequired` is synthesized from the current in-memory device flow and can contain only its public challenge; it is not stored in the orb row. `stateDetail` is synthesized the same way from in-memory reconciler state: while `stopping` it reports the history-drain blocker — for example a retrying database outage — so a long stop is explained rather than an unlabeled spinner, and new detail variants can be added later without schema changes. The dedicated history response exposes only the cursor/head needed for live handoff.

Status behavior:

- project creation returns `201`;
- orb creation and start/stop requests return `202` with the current `OrbView`;
- before creating/starting the host, the backend resolves and refreshes Codex OAuth; if user interaction is required, the orb remains in `creating`/`starting` and the response returns the device-login challenge in `actionRequired`;
- the browser polls only the normal orb resource, not an auth resource; when login succeeds the backend resumes lifecycle work automatically;
- lifecycle endpoints are idempotent when already moving toward or in the requested state;
- lifecycle work is asynchronous and recoverable from `orbs.state`; the browser polls `GET /api/v1/orbs/:orbId`;
- while an orb is `stopping`, the orb resource includes `stateDetail` so the requester sees drain progress and retryable blockers instead of an unexplained wait;
- a process restart finds `creating`, `starting`, and `stopping` rows and resumes reconciliation, including restarting a required OAuth flow, so no job table is needed;
- history is returned as one complete database snapshot without pagination in the first slice;
- the live upgrade is accepted only for a running orb; otherwise it fails with `409`/`1013` as appropriate.

All list responses use `{ items: [...] }`. Errors use one shape:

```ts
interface ControlPlaneHttpError {
  error: {
    code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "internal";
    message: string;
    retryable: boolean;
  };
}
```

Fastify handlers validate TypeBox schemas, call Result-returning services, and fold each result into an explicit response. They never use exceptions for normal HTTP control flow.

## 12. Lessons from Amp's “Putting an Agent in an Orb”

Primary reference: [Putting an Agent in an Orb](https://ampcode.com/notes/putting-an-agent-in-an-orb), Thorsten Ball, July 2, 2026. Related reference: [Amp Orbs manual](https://ampcode.com/manual/orbs).

We do not need to copy Amp's implementation, but several lessons directly inform pi-orb.

### 12.1 Relevant Amp choices

Amp currently:

- uses one fresh orb per thread;
- uses Debian 12 with a broad prescribed toolset;
- clones the repository automatically;
- runs repository-owned `.agents/setup` on fresh creation;
- runs a fast, idempotent `.agents/resume` on wake;
- snapshots a prepared sandbox and reuses it for up to 24 hours;
- pauses inactive orbs after 15 minutes;
- supports project environment variables, secrets, and short-lived OIDC workload identity;
- provides authenticated “portal” URLs for services running in an orb;
- provides a supervised service declaration (`.amp/services.yaml`);
- provides sync back to a local checkout;
- makes ports discoverable through generated metadata instead of hardcoding;
- centralizes logs, including browser console output, in an agent-readable location;
- invests heavily in layered `AGENTS.md` guidance, idempotent scripts, structured health/preflight endpoints, seeded users, and development-only authentication helpers.

Amp uses tmux for shared terminal/process workflows. pi-orb has explicitly chosen not to use tmux for its UI.

### 12.2 Design lessons to retain

The strongest lesson is not a particular VM API; it is **do not make the agent guess**.

Potentially applicable ideas:

- a fixed, well-documented base environment;
- short, idempotent setup and restart-repair hooks;
- snapshots/prebuilds after setup;
- a structured readiness/preflight endpoint that explains failures;
- generated port/service metadata;
- centralized, greppable logs including browser diagnostics;
- easy development-only authentication paths for applications under test;
- authenticated web portals to services inside an orb;
- short-lived workload identity instead of long-lived cloud credentials;
- supervised declared services rather than ad hoc detached processes;
- explicit source synchronization back to the user's checkout;
- rich `AGENTS.md` guidance near the code it describes.

These are inspirations and open design inputs, not committed first-slice features.

## 13. Evaluated and rejected approaches

### 13.1 Cloud Workstations

Cloud Workstations was evaluated and rejected due to pricing and limited value relative to a custom control plane:

- normal Compute Engine charges;
- an additional `$0.05 × vCPU` per active workstation hour;
- a fixed `$0.20/hour` cluster fee;
- no documented Spot configuration in the stable or beta workstation configuration schema;
- we would still need custom health, history replication, restart recovery, and application control-plane logic.

### 13.2 Suspend/resume

Suspend/resume was benchmarked on a Spot `n2d-highmem-4` in `us-central1-a`, using Debian 12 and Node.js 24. Across representative samples, resume generally saved only about 5–11 seconds relative to stop/start, with substantial variance. Suspend itself was slower than stop, though that latency could happen after the user left.

All tested resumes preserved process state, but the payoff did not justify another lifecycle path in the first version. One Spot preemption also occurred during the benchmark, reinforcing the need for full restart recovery.

Decision: implement stop/start only for now. All temporary benchmark cloud resources were deleted.

### 13.3 Pi over tmux or subprocess RPC

Rejected for the first slice:

- tmux as UI/session transport;
- running a remote Pi TUI;
- running `pi --mode rpc` behind a gateway child process.

Decision: embed Pi through the SDK in the orb runtime and build a web UI.

## 14. Deterministic simulation testing strategy

The [`determined`](https://www.npmjs.com/package/determined) package provides cooperative deterministic scheduling, reproducible entropy, failpoints, blocking primitives, deadlock detection, and exact record/replay of failing schedules. pi-orb does not require timed mutex or condition-variable APIs: it coordinates with database compare-and-swap, explicit lifecycle state, serialized in-process mutation queues, and cancellable adapter operations. Virtual sleep/deadline timers only need to participate correctly in scheduler quiescence and cancellation.

The architecture should keep side effects behind adapters and put concurrency/state-machine logic in simulation-compatible code. Initial high-value simulation targets are:

- repeated and delayed history pulls;
- runtime or database failure before a poll transaction commits;
- a polling worker crashing immediately before or after commit;
- overlapping pollers reading the same orb cursor;
- incomplete streaming records becoming complete between pulls;
- history load racing with live subscription;
- parent records arriving after children;
- controlled stop racing with newly completed agent output;
- pull-derived liveness and readiness health checks racing with stop/restart decisions;
- a non-retryable replication-integrity failure or a runtime restart during a pending drain;
- repeated provider operations and control-plane recovery after partial failure;
- concurrent orb starts sharing one OAuth device flow, OAuth completion/failure, and restart while login is pending;
- multiple reconcilers observing and acting on the same orb.

Simulation tests should:

1. run many entropy-driven schedules and failpoint combinations;
2. save the full entropy trace and relevant test configuration on failure;
3. verify that the saved trace reproduces the same failure;
4. make replaying a captured failure a simple test command;
5. assert invariants, not only expected happy-path outputs.

Important invariants include no cursor advancement without the corresponding database commit, stable native record IDs across repeated pulls, no omission of complete records after a cursor, no return of incomplete records, idempotent retries, no host stop after a retryably failed pre-stop pull (an integrity failure stops the host only together with the transition to `failed`), at most one authoritative host per orb, and no transition from a failed health observation directly into an idle stop decision.

`determined` controls cooperative scheduling and entropy, but not wall-clock time or external systems by itself. Core code also needs injectable clocks/timers and simulated adapters for the database, runtime transport, and host provider. Real integration tests remain responsible for validating adapter behavior.

For end-to-end tests, the one external dependency that cannot be exercised as-is is OpenAI (Codex OAuth plus the model backend). A scripted mock service exists (deployed at `fake-openai.flingit.run`; per-test isolated sessions with their own OAuth/inference base URLs, a scenario API, device-login approval, and received-request assertions). [`PI-CODEX-E2E.md`](PI-CODEX-E2E.md) records the decided integration mechanism: override the `openai-codex` provider via `registerProvider` with the mock `baseUrl` and a custom `oauth` implementation (`packages/mock-openai`) — a supported injection point, not DNS or fetch interception. E2E mode activates only when `PI_ORB_FAKE_OPENAI_OAUTH_URL` and `PI_ORB_FAKE_OPENAI_INFERENCE_URL` are set; the control plane routes its auth gate through the mock and passes the same variables into every orb container, and production never registers the override.

The implemented E2E test (`e2e/`, run with `npm run test:e2e`) drives the full §11.2 slice against real PostgreSQL, real Docker, and the real Pi SDK: device login approved through the mock's control API, a scripted turn whose tool call executes real bash inside the orb, streamed reasoning/tool frames over the live proxy, history replication verified in the database, and the controlled-stop drain with database-served history afterward. It clones the public pi-orb repository itself as the project under test. One integration constraint discovered while building it: the control plane's `ModelRuntime` must be created with `allowModelNetwork: false`, because `ModelRuntime.login` otherwise follows a successful login with a network model-availability sweep across all providers that can stall the device flow for minutes; the control plane resolves auth only and never needs the catalog.

The simulation boundary is decided: it is each application's `domain/` directory, mechanically enforced. Domain code imports only `determined`, `neverthrow`, and first-party interface types — no `pg`, Docker, `fetch`, Fastify, React, or Pi SDK imports — and every state machine receives `(task, clock, deps)`, where `deps` are the repository, host-provider, and runtime-client interfaces. Fastify handlers and UI code sit outside the simulation and are tested conventionally as thin folds over domain results. The control plane owns one shared deterministic test kit: in-memory repository, host-provider, and runtime-client fakes with simulated latency and failure injection, plus named failpoint constants, so all state-machine tests share the same fixtures and failure vocabulary. The kit's acceptance test is the concurrent-poller race: two pollers read the same cursor, both pull, the loser's compare-and-swap affects zero rows, and the replica ends with no duplicate or missing record.

State-machine timing uses two distinct patterns:

- periodic reconciliation waits with cancellable deterministic sleeps; in-process durations use `monotonicNow()`, while restart-stable deadlines derived from `state_changed_at` compare against injected `wallNow()`;
- each finite I/O/process/provider operation runs through a deadline helper that passes an `AbortSignal` into the adapter and always cancels its timer when the operation settles.

Code never `await`s an `AbortSignal` directly. APIs such as `fetch`, `execFile`, and simulated adapter sleeps observe it. A low-level cancellable-sleep implementation may await the signal's abort event internally. Avoid a bare `Promise.race` whose losing operation continues unobserved.

Baseline GitHub CI runs for every pull request and every push to `main`, using Node 24 and the committed npm lockfile. A single required checks job installs with `npm ci`, then runs the repository-wide typecheck, lint, and test scripts. Entropy-iteration budgets and deterministic failure-trace retention remain open.

DST tests must never be flaky; a non-reproducing failure is a schedule the scenario cannot survive and must be root-caused from its recorded trace (`DST_REPLAY`) before any fix (also recorded in `AGENTS.md`). Standing interplay found 2026-08-03: since idle auto-stop (§3.4) landed, any scenario that holds an orb in `running` across long virtual stretches without busy activity or a visible tab races the test idle window — such scenarios must either simulate activity or opt out via a `makeHarness` `idleStopAfterMs` override, as the restart-recovery lifecycle tests now do.

## 15. Security requirements and questions

The first local vertical slice intentionally has no authentication or authorization. Anyone who can reach the control plane can list, create, inspect, control, and stop every project and orb. The control plane-to-runtime hop is also unauthenticated. This deployment is suitable only on a trusted development machine/network and must not be exposed publicly.

### 15.1 OpenAI Codex OAuth credentials

The initial provider is hardcoded to Pi's built-in `openai-codex`, using a ChatGPT Plus/Pro subscription rather than an OpenAI API key. There are no model/provider/thinking-level environment variables or model-selection controls in the first slice. The orb model is pinned to `gpt-5.6-sol` (decided 2026-08-01); `pickCodexModel` falls back to the first *image-capable* catalog model and only then to the catalog head if a future Pi catalog drops that id. The image-capability constraint exists because the runtime advertises `input.image` and pi-ai's serializers silently drop image content when `model.input` lacks `"image"` — discovered when a pasted screenshot reached the persisted session but never the model, because the runtime then pinned the catalog head, text-only `gpt-5.3-codex-spark`. Default thinking level is unchanged; explicit model selection can be added only when the product needs it.

The actual stored credential is Pi's canonical OAuth object under the `openai-codex` provider key:

```ts
interface StoredCodexCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}
```

The refresh token is the durable secret; access tokens are short-lived and automatically refreshed.

#### Lifecycle-triggered login

There is no standalone frontend auth API or auth-state polling. OAuth is a backend prerequisite within orb create/start:

1. Before moving an orb into host creation/start, the control plane asks Pi's `ModelRuntime` to resolve `openai-codex` auth. This refreshes an expired access token under the credential-store lock when the refresh token remains valid.
2. If auth resolves, lifecycle proceeds without showing any auth UI.
3. If the credential is missing or cannot be refreshed, the orb remains in its durable `creating` or `starting` state while the control plane starts one global `ModelRuntime.login("openai-codex", "oauth", interaction)` operation. Its `AuthInteraction` automatically selects Pi's headless `device_code` method.
4. The create/start response's `OrbView.actionRequired` contains only the OpenAI verification URI, user code, and expiry. The browser displays it while continuing its ordinary orb polling; it never calls or polls an auth resource.
5. When login succeeds, Pi persists the credential and the backend wakes every orb blocked in `creating`/`starting`, resuming host lifecycle work automatically.
6. If login expires or fails, waiting orbs move to `failed` with a typed non-secret error. A later start request may initiate a new flow.

Only one global login attempt may run at once, and simultaneous blocked orbs share its challenge. Pending attempt/challenge state is in memory; each orb's `creating`/`starting` intent is durable in PostgreSQL. After a control-plane restart, the reconciler rechecks auth for those states and starts a fresh device flow if needed. Every Pi/OAuth rejection or exception is caught at this adapter boundary and converted to a typed `Result` error.

#### Storage and runtime access

The control plane keeps Pi's standard `AuthStorage` with `auth.json` in a dedicated control-plane-owned location (default `~/.pi-orb/auth`, configurable via `PI_ORB_AUTH_DIR`) as the device-login artifact for the gate's `ModelRuntime`, plus a private `broker-secrets/` directory as the local secret store. Nothing under that directory is ever mounted into an orb: orb containers receive exactly two environment variables — `PI_ORB_CONTROL_PLANE_URL` and `PI_ORB_RUNTIME_TOKEN` — and obtain access tokens from the broker (below). An earlier first-slice mechanism that bind-mounted `auth.json` into every orb container was replaced by the broker and removed.

Do not write OAuth credentials to PostgreSQL, images, project volumes, Pi session history, logs, or HTTP responses. No browser-facing response type imports or contains Pi's stored credential type; `OrbView.actionRequired` can represent only the public device-login challenge. Add a response-schema test that fails if `access` or `refresh` can be serialized.

This shared file is intentionally the simplest local implementation, not a security boundary. Orb code may be able to read the mounted subscription credential, and anyone able to request orb creation/start may trigger the global login flow. The first slice therefore trusts all users and repository code.

Decided for the cloud slice: replace the mounted file with a **control-plane credential broker**, as one unified mechanism on both Docker and GCE from day one. The mounted-`auth.json` path is removed, not kept as a second path, so local and cloud auth never diverge and the existing E2E against the fake OpenAI service exercises the broker. A Secret-Manager-backed store was rejected because it changes only where the refresh token is stored, not that it lands inside an orb running untrusted repository code. Decided shape (detailed design pending; see open question 21):

- The broker lives in the control plane next to `PiAuthGate`, which continues to own `ModelRuntime` and `auth.json`. Refresh tokens never leave the control plane.
- A runtime-facing control-plane endpoint returns a current short-lived access token. It is authenticated by a per-host-incarnation bearer token scoped to that orb only and valid only while the orb is meant to be running.
- The orb runtime registers a provider config (the same `registerProvider` mechanism the E2E mock uses) whose `getApiKey`/`refreshToken` delegate to that endpoint; from Pi's perspective nothing is unusual.
- Providers deliver exactly two environment variables — the control-plane base URL and the orb token — via `--env` on Docker and via instance metadata forwarded into the container on GCE. This env contract is the entire provider-specific surface.
- Accepted limitation until the identity model exists (open question 24): repository code inside an orb can read the orb token and thus obtain short-lived access tokens. What it can no longer obtain is the refresh token.
- Token lifetime/renewal semantics, refresh coalescing, and the 401-retry path are settled in the detailed design below.

#### Credential broker detailed design

Status: **implemented** (designed, revised after an external Codex review, then built): broker domain and DST scenarios in `apps/control-plane/src/domain/broker.ts`, the runtime-facing route in `http/runtime-routes.ts`, pg pointer store / file secret store / OAuth refresher adapters, per-incarnation token minting in the Docker provider, and the runtime-side client (`apps/orb-runtime/src/domain/broker-client.ts`) with its HTTP endpoint and Pi provider config. The mounted `auth.json` path is gone on every provider; the full E2E exercises this path.

**Division of responsibility.** The control plane is the credential owner: it runs the device login (unchanged `PiAuthGate`), performs every upstream refresh, and holds the only durable copy of the refresh token. The orb runtime is a consumer of short-lived access tokens and holds them in memory only; no refresh token ever exists in the runtime process. The existing no-credential-serialization guard remains scoped to browser-facing responses — the runtime endpoint below intentionally serializes an access token.

**Runtime-facing endpoint.** One parameterized route, versioned separately from the browser API because its compatibility story is deployment-internal. (Generalized 2026-08-03 from the original `POST /runtime/v1/model-token` — renamed outright, no compatibility alias, per the POC stance in `CLAUDE.md`; `{name}` is a logical token name mapped internally to a provider, §15.3.)

```text
POST /runtime/v1/tokens/{name}        name ∈ "model" | "github"
Authorization: Bearer <orb token>

request  { "reason": "startup" | "expiring" | "rejected", "staleGeneration"?: number }
200      { "accessToken": string, "accountId"?: string, "expiresAt": number, "generation": number }
         // expiresAt in ms since epoch; Cache-Control: no-store
         // accountId: account id on model grants, user login on github grants
401      unknown, invalid, or lifecycle-revoked orb token
404      { "error": "unknown_token" }  // name outside the schema
409      { "error": "auth_required" }  // no usable credential; device login must run
429/5xx  retryable; the runtime backs off with jitter and honors Retry-After
```

`generation` is an opaque broker-issued counter identifying the current stored credential; the runtime echoes it as `staleGeneration` when reporting a rejected or expiring token. The broker refreshes upstream only when `staleGeneration` matches the current generation — otherwise someone already rotated and it serves the newer token. A client-controlled timestamp was rejected as the fingerprint: it is not unique and lets a malicious orb force continuous rotation. As a backstop against forced-rotation abuse, upstream refreshes are additionally rate-limited globally (initially at most one per 30 seconds unless the current token is expired). Independent of callers, the broker refreshes when remaining lifetime falls below a threshold (initially 5 minutes).

**Orb token.** 256-bit random value minted per *host incarnation*, using a **read-back model** (implemented): the provider mints the token only when it actually creates a container or VM and injects it into the host's delivery channel (`--env` on Docker, instance metadata on GCE); when `provision` finds an existing host it reads the token back from that channel instead of re-minting. `provision` returns the SHA-256 of the token the host *actually carries*, and the control plane commits that observed hash (state-version CAS) alongside the host ref. An earlier commit-hash-before-create scheme was rejected: with concurrent reconcilers it allowed a stale provisioner to leave a host whose env no longer matched the committed hash, because nobody could re-derive the plaintext. Under read-back the hash always follows reality — concurrent provisions observe the same host and report the same hash, and a replaced host (which may keep its Docker container name) is caught by comparing the hash, not just the ref. The plaintext never appears outside the provider adapter and the host itself. GCE restart-in-place keeps the same incarnation and token; replacing a container or VM rotates it. There is a benign window where a host runs before its hash is committed; the runtime treats broker 401s at boot as retryable-for-a-bounded-time, and the create/start readiness deadline is the backstop. A hash of an internal bearer token is not an OAuth credential and does not violate the no-credentials-in-PostgreSQL rule. Lookup is by indexed hash with constant-time comparison. The token authorizes only `/runtime/v1/*` for its orb, and only while the orb's lifecycle state says the host should be up (`creating`/`starting`/`running`/`stopping` — `creating` is included because the first boot fetches its token before the orb ever reaches `running`); tokens of stopped or failed orbs are refused. Accepted for the single-account phase: repository code can read the token and, while its orb runs, obtain access tokens reachable only from inside the deployment's network; what it can never obtain is the refresh token.

**Pi adapter (runtime side).** Pi's provider-OAuth contract is: `getApiKey(credentials)` is synchronous, `refreshToken(credentials)` is async and returns a full OAuth credential, and *Pi* decides when to refresh based on the stored credential's expiry. The adapter therefore works as follows: during boot the runtime calls the broker once and seeds its in-memory credential store with `{access, expires, refresh: "<broker>"}` — a synthetic refresh marker, since the real refresh token never leaves the control plane; `getApiKey` synchronously returns the stored access token; `refreshToken` calls the broker and returns the new credential with the same marker; `login` always fails — login happens only in the control plane. The pinned-SDK contract test (`apps/orb-runtime/src/broker/provider.contract.test.ts`, run against the exact installed Pi version) pins this contract: login drives the broker and persists only the synthetic marker; an unexpired credential resolves without a refresh; an expired credential triggers exactly one coalesced broker refresh that is persisted before use; a failed refresh rejects resolution, leaves the stored credential intact, and is retried on the next resolution. **Pinned finding (2026-08-01):** this SDK version has *no* 401-triggered refresh path — auth is resolved per request and refreshed only when `Date.now() >= expires`, so an upstream 401 from a revoked-but-unexpired token fails the operation without any refresh attempt, and no partially consumed stream is ever replayed (nothing retries it). An earlier sketch of runtime-side refresh-then-retry-once on 401 is therefore not implemented and not needed while broker `expiresAt` values are accurate; the broker's proactive rotation (5-minute-remaining threshold) is the mitigation, and mid-run revocation recovery remains stop/start (open question 31). The runtime's `"rejected"` token-request reason is reserved for a future SDK that surfaces 401s to the provider hook. Mock mode composes cleanly and gets simpler: the fake-inference base URL override stays an env concern, the OAuth side becomes broker-backed in both modes, the runtime's device-flow mock code is deleted, and the fake sees refresh traffic from the control plane only.

**Durable storage and fenced mutations.** Cloud Run filesystems are ephemeral, so the refresh token cannot live in a file there. Local development keeps the `auth.json` file store; the cloud control plane stores the credential in Secret Manager, with a PostgreSQL *credential-pointer row* as the source of truth: `{generation, secretVersion}`. Readers load the pointer and read that exact numeric secret version — never `latest`, whose read-after-write consistency is not guaranteed. Every mutation (login write, refresh write, invalidation) is fenced: it names the generation it read, and commits via compare-and-swap on the pointer row — the same optimistic-CAS philosophy the replication cursor already uses. An advisory lock was rejected as the correctness mechanism because a dropped connection releases it while its holder may still be mid-flight; instead, coalescing uses a short lease value CAS'd into the pointer row (bounded, expiring), so no database lock is ever held across an external call and a crashed leaseholder just times out. `invalid_grant` clears only the generation that was submitted upstream — a stale failure can never clobber a newer credential. Superseded secret versions are destroyed best-effort after the pointer moves.

**Acknowledged loss window.** Upstream refresh rotates the refresh token, and no protocol makes "upstream accepted the rotation" and "we durably stored the result" atomic. If the process dies, or the response is lost, between upstream acceptance and the Secret Manager write plus pointer CAS, the only usable refresh token may be gone. This is accepted: the outcome is a forced re-login, surfaced as `auth_required`, not silent corruption. The write path retries hard within its lease and fails loudly. Deterministic tests must cover the three shapes: response lost after upstream acceptance; death after response, before persist; login completed but death before persist.

**Failure semantics.** Transient upstream or storage failures (network, 429, 5xx, Secret Manager outage) while the current access token is still valid do *not* fail token requests — the broker serves the valid token and retries refresh in the background of subsequent requests; only an expired-or-rejected token combined with a failing refresh surfaces an error. `invalid_grant` is terminal: the credential pointer is cleared (fenced) and subsequent calls return `auth_required`. Mid-run recovery needs no new machinery in the first iteration: a revoked credential fails the active agent operation with a typed auth error, the orb stays up, and recovery is stop/start — which re-runs `ensureAuth` and the device flow. A standalone re-login action that does not bounce the orb is a recorded follow-up (open question 31).

**Cloud exposure.** Three Cloud Run services from the same image, gated by a role env var that controls which routes are *registered* (a hard allowlist, not hidden-by-convention): the browser-facing service (behind IAP, min one instance, instance-based billing, runs the poller and the login flow) a tooling-facing `ops` service (the browser API surface with no loops, migrations, or web assets; public ingress but invoker-IAM restricted to the `pi-orb-debug` service account, reached via impersonated ID tokens — `infra/api.sh`), and a runtime-facing service registering only `/runtime/v1/*`, with `ingress=internal`, unauthenticated at the Cloud Run IAM layer by explicit decision — caller authentication is the orb token; requiring Google identity tokens from the VM would push GCP-specific auth into the runtime, which stays provider-agnostic (URL + bearer token on every provider). Both properties (internal ingress, route allowlist) are enforced in OpenTofu. The previously sketched fallback — one service behind an external load balancer with `ingress=internal-and-cloud-load-balancing` — was rejected: VPC-internal callers (i.e., orbs) could reach the `run.app` origin directly and bypass IAP entirely, so it would be safe only with app-level verification of signed IAP assertions on every browser route.

**GCE identity hardening.** Orb VMs never run as the default Compute service account: they get a dedicated service account with only Artifact Registry read and log writing, because untrusted repository code can query the metadata server and mint that account's tokens. (The same metadata server exposes the orb token to code on the VM — already accepted above.)

The control plane's own compute access is similarly fenced (decided and applied 2026-08-01, because the dev project hosts other services' VMs): its `roles/compute.instanceAdmin.v1` binding carries an IAM condition restricting mutations to resources named `…/instances/pi-orb-*`, `…/disks/pi-orb-*`, and the `pi-orb*` subnetworks, plus an unconditioned `roles/compute.viewer` for list/get/guest-attribute/operation-wait reads, which target collection and operation resources a name condition can never match. Even a control-plane bug therefore cannot mutate foreign VMs — the application-layer guarantees (atomic creation-time `pi-orb-orb-id` labels, label-filtered `listManagedHosts`, exact `pi-orb-<uuid>` naming) are backed by the permission layer. Validated on live infrastructure: a full stop → script-repair (`setMetadata`) → start cycle succeeded under the conditioned binding.

**Local Docker parity.** On the shared local Docker network, orb containers can reach the whole control plane, not just `/runtime/v1/*`, and traffic is plaintext. Accepted for single-user development on a trusted machine; noted as a gap to close (separate broker listener or network) if that assumption ever changes.

**Abuse bounds.** Per-orb token-endpoint rate limiting, the global upstream-refresh rate limit above, and a Cloud Run max-instances cap bound what a hostile orb can do: at worst it consumes the shared account's inference quota — inherent to the single-account phase — but it cannot force unbounded rotation or scale-out.

**Deterministic simulation and contract tests.** Broker logic is control-plane domain code behind ports (`SimulationTask` clock, upstream refresher, secret store with pointer CAS, lease). Failpoints beyond the happy paths: refresh storm coalescing to one upstream call; rotation race between two instances; leaseholder crash mid-refresh; the three loss-window shapes above; stale `invalid_grant` racing a successful refresh; login racing refresh; database connection loss mid-mutation; upstream 429-then-success. The runtime-side adapter (seed, refresh, 401 singleflight) gets the same port treatment. What simulation cannot validate — Pi's actual callback/401 behavior, Cloud Run ingress and IAM, IAP, metadata-server exposure — is covered by the pinned-SDK contract test and the cloud-slice validation exercise.

### 15.2 Requirements before public deployment

- Authenticate browser access and authorize every project/orb operation.
- Authenticate runtime/control-plane communication.
- Do not bake secrets into images.
- Use short-lived, single-use registration credentials for runtime bootstrap.
- Prefer short-lived workload identity over forwarding developer credentials.
- Treat repository setup hooks and project-local agent extensions as executable, trusted code.
- Keep the host-provider control path unavailable to arbitrary project processes.
- Use least-privilege service accounts in GCP.

Still open for that later security phase:

- user authentication and authorization model;
- runtime identity after bootstrap registration;
- GitHub repository authentication and token lifetime;
- per-user/project model credentials, Secret Manager integration, and rotation;
- Cloud SQL authentication and network topology;
- secret/environment-variable scope and auditability;
- whether project code is trusted, semi-trusted, or hostile;
- portal/forwarded-port authorization.

### 15.3 GitHub credentials for `gh` and git push (decided and implemented end to end 2026-08-03: user OAuth device flow)

Goal: `gh` is installed in the runtime image and works inside orbs without manual login, so agent shell commands can open PRs, read issues, and check CI, and `git push` over HTTPS works for authorized repositories.

The credential broker (§15.1) is the vehicle: the GitHub token route reuses the orb-token authentication from `runtime-routes.ts` verbatim, and `credential_pointers` is already keyed by provider, so a `github` row slots in beside `openai-codex` with no schema change. Injecting a raw long-lived key as an orb environment variable is the anti-pattern the broker replaced — it would bake the secret into the GCE startup script and instance metadata, expose a durable credential to repository code, force a script-hash bounce of every orb on rotation, and violate the §15.2 requirements ("do not bake secrets into images", "prefer short-lived workload identity over forwarding developer credentials").

**Decided: user OAuth device flow** (GitHub App user-to-server tokens with expiration enabled), because PRs and comments must be authored *as the user*, not a bot. Identical in shape to the existing `openai-codex` pointer: a device-code login ceremony (analogous to `PiAuthGate`) captures a refresh token into Secret Manager; the broker vends ~8-hour access tokens and refreshes them behind the existing lease/generation mechanics (GitHub rotates the refresh token on every use — the fenced-CAS machinery and the acknowledged loss window of §15.1 apply unchanged).

This still requires registering a **GitHub App** — but the app is only the OAuth client registration, not the acting identity. Two reasons a classic OAuth App does not work: its user tokens never expire and have no refresh token, so the broker would be vending a durable credential (the exact failure of the PAT option below); and its scopes are coarse (`repo` is everything). Only GitHub App user-to-server flows offer expiring tokens plus rotation and fine-grained permissions. Registration is a settings-page form (no review or marketplace listing): enable device flow, keep "expire user authorization tokens" on, install the app on the account/repositories it may reach. Resulting tokens are constrained to the intersection of the user's access and the app's installation — a useful blast-radius bound. One wrinkle: the device-flow *initial* grant needs only the client id, but *refreshing* requires the app's client secret, so the client secret is a second control-plane-only durable secret (Secret Manager beside the refresh token; it never leaves the control plane).

**Control-plane implementation (2026-08-03).** The GitHub provider reuses the broker core wholesale — `credential_pointers` row `github`, GSM parent secret `pi-orb-credential-github`, the same fenced-CAS refresh mechanics — with these additions:

- `BrokerDeps.upstream` became per-provider `upstreams` (a provider with no refresher serves still-valid tokens and reports retryable otherwise). `GithubUpstreamRefresher` does the rotating `refresh_token` grant against `github.com/login/oauth/access_token` with the client secret; `bad_refresh_token` maps to `invalid_grant`, clearing the pointer and re-opening the ceremony. GitHub answers OAuth errors as HTTP 200 with an `error` body field; both adapters inspect the body.
- `GithubAuthGate` (domain, behind a `GithubOAuthClient` port) runs the device ceremony with **no background driver**: each reconciler `ensureAuth` call advances the flow by at most one poll, respecting the device-flow interval and `slow_down` backoff — the whole ceremony is deterministically simulable. An authorized-but-uncommitted credential is held in memory and the commit retried on later calls, so a store hiccup never forces a second ceremony. The `/user` login lookup fills `accountId` (falling back to `"unknown"` rather than losing a credential).
- `CompositeAuthGate` chains Codex → GitHub: the first blocking resolution wins, so the user sees one device challenge at a time; orb create/start now gates on both ceremonies (each is once-ever). `DeviceChallenge` carries a `provider`, surfaced as `actionRequired.type` `github_device_login` and a per-provider UI banner label.
- Configuration: `PI_ORB_GITHUB_CLIENT_ID` + `PI_ORB_GITHUB_CLIENT_SECRET`; when unset the gate and refresher are simply not wired — `tokens/github` answers `auth_required` and nothing else changes (local dev and E2E unaffected). In the cloud, the client id is the `github_client_id` tofu variable and the client secret lives in Secret Manager (`pi-orb-github-client-secret`, version added manually via `gcloud secrets versions add` after registering the app); both the browser service (gate) and runtime service (refresher) receive them.
- DST coverage (`github-auth.dst.test.ts`): ceremony-to-served-token happy path; poll pacing (never faster than the interval, wider after `slow_down`); expired device code → fresh flow; denied → later retry; commit-failure recovery without a second ceremony; transient device-code/poll failpoints; cross-provider isolation (Codex pointer untouched); composite ordering (GitHub ceremony never starts while Codex blocks). What simulation cannot validate — GitHub's real OAuth responses — is the thin HTTP adapter, exercised on the live slice.

Rejected alternatives:

- **App installation tokens** (`pi-orb[bot]` identity): simpler (stateless minting from the app private key, no refresh rotation), but rejected because actions would be authored by the bot, not the user.
- **Fine-grained PAT vended by the broker:** the token handed to the orb is itself the durable credential — repository code could exfiltrate something long-lived, which crosses the line the broker exists to hold.
- **Injection as a static orb env var** (any credential shape): see above.

**Unified runtime token route (decided and implemented 2026-08-03).** Per-credential endpoints are rejected; the runtime token surface is one parameterized route, and the former `/runtime/v1/model-token` migrated into it. The wire spec lives in §15.1; the design points:

- `{name}` is a *logical token name*, not the upstream provider id: the control plane maps `model → openai-codex` and `github → github` internally (`TOKEN_PROVIDERS` in `domain/broker.ts`). The runtime asks for a capability; which provider backs it is the control plane's business, so a future model-provider change never touches the runtime contract.
- One shared request/grant/error schema in `packages/protocol/src/broker.ts` (`TokenRequestSchema` / `TokenGrantSchema` / `TokenErrorSchema`, plus `TokenNameSchema` and a `runtimeTokenPath(name)` helper replacing `MODEL_TOKEN_PATH`). `accountId` is optional; the GitHub grant carries the user's login there. The `reason`/`staleGeneration` anti-forced-rotation semantics apply per name, since generations already live on the per-provider pointer row.
- One route handler validates `{name}` against the schema (unknown name → 404 `unknown_token`) and dispatches to the provider-keyed broker core (`getToken`); auth, status mapping, and `Cache-Control: no-store` are shared. `tokens/github` answers `auth_required` until the GitHub provider lands.
- Migration: none — POC stance (decided 2026-08-03, recorded in `CLAUDE.md`): `/runtime/v1/model-token` is renamed outright with no deprecated alias; a running orb still on the old path fails its next token refresh and is simply stopped and restarted.

Runtime consumption (implemented 2026-08-03; the shim approach was chosen over the SDK bash-tool `spawnHook` because it needs no SDK coupling and covers every subprocess — `spawnHook` remains available if per-command env injection is ever needed):

- `gh` is installed in the runtime Dockerfile from GitHub's official apt repository. No `gh auth login`, no `hosts.yml` — `$HOME` is in the ephemeral container layer, and a static file would freeze a token that should stay short-lived; nothing is persisted.
- Tokens are vended at point of use by a one-shot CLI (`apps/orb-runtime/src/gh/cli.ts`, reusing `HttpBrokerEndpoint`/`BrokerTokenClient` against `tokens/github` with tight ~10s retry windows). Two consumers in the image:
  - `/usr/local/bin/gh`, a shim ahead of the real binary on `PATH`, fetches a fresh token and execs `/usr/bin/gh` with `GH_TOKEN` set (a caller-provided `GH_TOKEN` wins; on fetch failure gh runs unauthenticated with the reason on stderr);
  - a git credential helper wired via the image's *system* gitconfig for `https://github.com` only (`username=x-access-token`, `password=<token>`), which makes `git push` work natively and stays silent for every other host — the §11.1 clone rules are untouched.
- Exposure class: repository code can obtain a short-lived, scoped GitHub token — the same accepted exposure class as model access tokens (§15.1); the durable secrets (client secret, refresh token) never leave the control plane.
- Private-repo clone remains a separate decision; the credential helper is the seam it would reuse.

The app is registered as installable on **the owning account only** (decided 2026-08-03): the broker's single `github` slot means every orb acts as the one user who completed the ceremony, so a public app would grant nothing today. The setting only controls who may install the app — a private app can be made public later from its settings when the multi-user milestone (open questions 24/25 — per-(user, provider) credential pointers, per-user ceremonies) makes other installations meaningful.

Still open: which repositories/permissions the app is granted (a settings-page decision at registration time); whether private clone rides along or waits.

## 16. Deferred suborbs

First-class child orbs/subagents are a product goal but not part of the first slice.

Likely future properties:

- parent agent tools to spawn, inspect, message, wait for, and cancel child work;
- control-plane enforcement of concurrency, cost, TTL, and nesting limits;
- branch/worktree isolation so agents never concurrently mutate the same working tree;
- structured results including summary, patch/commit, tests, artifacts, and cost;
- selectable isolation such as process, container, or full orb.

No child-orb protocol has been finalized.

## 17. Initial repository layout and stack

These choices are accepted for the first vertical slice. Start small and extract or add dependencies only after a concrete need appears.

### 17.1 Language and workspace

Recommend:

- TypeScript throughout the runtime, control plane, web UI, shared contracts, and tests;
- Node.js 24 and ESM modules;
- npm workspaces using the npm already shipped with Node, one lockfile, and no additional package-manager dependency;
- no Nx, Turborepo, or general task orchestrator;
- `tsc --build` for type checking/production compilation and Vite only for the browser build;
- Node's built-in TypeScript stripping for server-side development/tests where its supported erasable syntax is sufficient;
- strict compiler options including `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and `erasableSyntaxOnly` where compatible.

TypeScript lets the Pi SDK, `determined`, `neverthrow`, protocol schemas, server, and browser share one type system. Network boundaries still require runtime validation; compile-time sharing is not wire validation.

### 17.2 Directory layout

```text
apps/
  control-plane/
    src/
      domain/           # polling/lifecycle state machines and interfaces
      adapters/         # PostgreSQL and Docker CLI adapters
      http/             # Fastify routes and WebSocket proxy
  orb-runtime/
    src/
      pi/               # Pi SDK integration and history mapping
      http/             # history pull and live WebSocket endpoints
  web/                  # React browser UI

packages/
  protocol/             # TypeBox schemas and inferred wire/history types

infra/
  opentofu/             # added when the cloud slice begins

docker-compose.yml      # local PostgreSQL and static development services
package.json
tsconfig.base.json
```

Only `protocol` is a shared package initially because it has three real consumers. Keep `OrbHostProvider`, repositories, Pi integration, fakes, and tests inside the application that owns them. Extract `domain`, adapters, providers, or test-support packages only when another application genuinely needs them.

The web app depends on `protocol`, not control-plane implementation code. Domain directories contain no Fastify, React, PostgreSQL, Docker, or Pi imports. Avoid generic `common` or `utils` packages.

### 17.3 Dependencies that earn their keep now

Runtime dependencies:

- `neverthrow`: mandatory Result-based error handling;
- `determined`: mandatory deterministic scheduling/failure simulation;
- `@earendil-works/pi-coding-agent`: the first harness;
- `fastify`: robust HTTP routing, body limits, lifecycle, and schema integration for both servers;
- `@fastify/websocket`: WebSocket upgrade/lifecycle integration (and its `ws` implementation);
- `typebox`: one source for runtime JSON validation and inferred TypeScript protocol types;
- `pg`: the only database layer;
- `react` and `react-dom`: the web UI.

Development/build dependencies:

- the latest stable `typescript` release, pinned exactly so compiler upgrades are explicit;
- `vite` and `@vitejs/plugin-react`;
- `@biomejs/biome`, pinned exactly, for repository-wide linting, formatting, and import organization; a scoped GritQL plugin preserves the no-throw rule for first-party production code while allowing test assertions and deterministic-testkit invariants to throw;
- `vitest` for unit, adapter, component, and deterministic simulation tests;
- `@playwright/test` only when the browser E2E test is implemented.

Everything else should begin as first-party code or use an existing CLI.

### 17.4 HTTP, WebSocket, and schemas

Keep Fastify, `@fastify/websocket`, and TypeBox because replacing them would mean writing and securing our own router, request body handling, upgrade lifecycle, and runtime validators. Share TypeBox schemas through `packages/protocol` and infer types from them.

Use native `fetch` for HTTP. Wrap external calls immediately with `ResultAsync.fromThrowable`, validate status and body explicitly, and return a typed error. Do not use tRPC, Axios, or a generated API client initially.

### 17.5 Database

Use `pg` directly with parameterized SQL. The initial schema and query set are small, and adding Kysely now would duplicate abstractions before it provides enough value.

- Write explicit transaction helpers that issue `BEGIN`, `COMMIT`, and `ROLLBACK` and return `ResultAsync`.
- Keep numbered SQL migration files and a small migration runner.
- Validate/map database rows at the adapter boundary rather than trusting untyped driver output.
- Define repository interfaces next to the control-plane domain code.
- Provide a deterministic in-memory implementation for DST and real PostgreSQL integration tests.

Add a typed query builder later only if query volume or refactoring pain demonstrates the need. Do not use a transaction API that requires throwing to roll back.

### 17.6 Web UI

Use React with Vite, browser APIs, and a small first-party reducer/context for HTTP and WebSocket state.

Do not add TanStack Router, TanStack Query, or a state-management package initially. The first UI has few routes and one live session. Add a router or query-cache library only after navigation/caching behavior becomes nontrivial.

Use the shared TypeBox schemas to validate data received by the browser. Add Playwright when the first browser E2E flow exists. Defer styling/component-library selection.

### 17.7 Tests, logging, Docker, and infrastructure

- Use Vitest for domain, protocol, adapter, component, and `determined` tests.
- Use real PostgreSQL and Docker integration tests where fakes cannot establish adapter correctness.
- Use a tiny structured JSON logging wrapper around `console` initially instead of Pino.
- Implement `DockerOrbHostProvider` by invoking the Docker CLI with `execFile`, wrapped at the boundary, instead of adding Dockerode.
- Invoke the Git CLI directly for cloning rather than adding a Git library.
- Add OpenTofu/Terraform only when implementing the cloud deployment; it is not an application dependency.
- Add the GCE client only when `GceOrbHostProvider` is implemented.

Test framework assertions and React/framework error boundaries may use exceptions where their contracts require them; production/domain APIs remain Result-based. Every external adapter owns immediate exception/rejection conversion. No Docker, database, filesystem, Git, HTTP, Pi SDK, or future GCP exception may cross into domain code.

## 18. Open questions

### Immediate architecture

1. Finalize the remaining HTTP/WebSocket payload details, capability negotiation, and versioning rules.
2. Fully resolved by the validation exercise (`experiments/cloudrun-ws-validation/RUNBOOK.md`, 2026-07-30): the request timeout must be raised from the 300-second default (measured forced close at 301 s) to the 60-minute maximum (measured forced close at 3601 s, code 1006, clean ~1 s reconnect — the ordinary resynchronization path handles it); Direct VPC egress carries a WebSocket from Cloud Run to an internal-IP COS VM with no external addresses involved, and such outbound connections are exempt from the request timeout (measured 11.4 h, zero drops, ended only by instance replacement); direct IAP-on-Cloud-Run is available, gates unauthenticated traffic, and passes browser WebSockets after sign-in; billable instance time is a flat one instance regardless of open sockets under instance-based billing (measured over 12+ hours). The load-balancer fallback is unnecessary.

### Replication and history

3. Define stable adapter-generated IDs for harnesses that do not provide native record IDs.
4. Compare real Claude Code and Codex persisted history examples before freezing the normalized schema.
5. Decide which additional record variants deserve static types beyond message, compaction, and generic event.
6. Decide how to replicate and store images, large outputs, truncated outputs, patches, and artifacts.
7. Define what the UI indicates, if anything, when live history is newer than the replica.

### Lifecycle and background work

8. Resolved: Pi SDK 0.83.0 has no shell registry or reliable query for surviving agent-started processes; only active awaited execution/tool lifecycle is observable (§3.4).
9. Determine whether ordinary OS process/cgroup inspection is reliable enough to avoid a custom background-job tool.
10. Resolved: a browser connection prevents automatic idle shutdown only while its tab reports `visible`; hidden or non-reporting connections do not count (§3.4).

### Project and environment

11. Define clone failure handling, default-branch behavior, and recorded repository metadata.
12. Choose the runtime container base-image pin and Node 24 release/update policy. (The VM host-OS half of this question dissolved: cloud hosts boot Container-Optimized OS and only run the runtime container, §3.3.)
13. Decide whether to adopt `.agents/setup` and a restart hook inspired by Amp.
14. Decide how setup caching/prebuilt snapshots work after the unoptimized first slice.
15. Decide which tools and services are installed in the prescribed base image. (Resolved for `gh`: installed in the runtime image with brokered auth, §15.3; the broader tool list remains open.)
16. Decide if/when an Orbfile is introduced and what it is allowed to configure.
17. Decide how services, ports, logs, browser automation, and preview URLs work.

### Control plane, database, and deployment

18. Define the abstract history repository/database interface.
19. Resolved: OpenTofu manages the static infrastructure plane; per-orb VMs stay dynamic provider resources outside IaC (§3.6).
20. Decide how to partition polling later if redundant all-orb polling becomes inefficient at scale; no leader or partitioning is needed initially.
21. Resolved: credential-broker and per-orb-token design written (§15.1); networking decided: Direct VPC egress to internal instance IPs (§5). Remaining: implement it, and validate direct IAP-on-Cloud-Run during the WebSocket validation exercise.
22. Define observability, audit logging, metrics, and cost attribution.
23. Resolved: the orphan-host sweep in §3.4 is the decided design — a periodic idempotent loop over `listManagedHosts` that only ever stops pi-orb-labeled hosts, never starts or deletes.

### Product and security

24. Define the future user/project/orb identity and authorization model before public deployment.
25. Define future per-user/project model credentials and private-Git credentials/workload identity. (A proposal for brokered GitHub credentials exists in §15.3.)
26. Define project trust and the security boundary for repository-controlled code.
27. Define orb deletion/export behavior and retention of replicated history.
28. Define whether stopped hosts have an expiration/garbage-collection policy.
29. Define the eventual suborb orchestration and filesystem handoff model.

### Testing

30. Define CI iteration budgets and storage/replay conventions for failing entropy traces.
### Cloud slice follow-ups

31. Add a standalone re-login action so a mid-run credential revocation can be repaired without stopping and starting the orb (§15.1: today recovery is stop/start).
32. Resolved (2026-08-01): the script-version stamp is implemented in `GceOrbHostProvider` — see the §3.3 rollout-caveat entry for the mechanism, the upgrade-delivery side effect, and the accepted drain-window residual.
33. TODO — close the served-vs-durable persistence gap (§8.5 field finding, 2026-08-03): the runtime answers history pulls from in-memory session entries while the SDK persists with `appendFileSync` and no fsync, and the SDK loader silently drops a truncated tail line on reload. A hard host stop can therefore lose a record the control plane already replicated and committed as its cursor, stranding the orb in a `cursor_not_found` integrity failure. Candidate fixes: serve only durably-persisted entries (fsync barrier or persisted-watermark cursor), fsync at drain time, and/or make the loader surface a truncated tail as a load error instead of silence. Related hardening from the same incident: abort the GCE startup script when the data-disk mount fails (never bind-mount an empty directory as `/workspace`), refuse to silently create a fresh session when the control plane already holds replicated history, and add an operator replication-reset as the recovery escape hatch.
34. TODO — make the full-slice E2E runnable on macOS Docker Desktop: the Docker provider hands the control plane the container's bridge IP ("prefer the bridge-network IP so a host-run control plane can reach the runtime"), which is unreachable from the host on Docker Desktop (verified 2026-08-04 — connections hang, readiness always times out). Candidate fixes: publish the runtime port to a host loopback port and use it in the observation when the control plane is host-run, or run the E2E control plane inside the Docker network. Until then the E2E only passes where container IPs are host-routable (Linux, OrbStack).
