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
- Support a linear conversation and compaction. Do not expose branching, session switching, cloning, or forking initially.
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
- The current prescribed cloud location is `us-central1`.
- The current prescribed GCE shape is Spot `n2d-highmem-4`: 4 vCPUs and 32 GiB RAM.
- The host OS will be a fixed Debian image. Debian 12 is the current intended baseline.
- Node.js 24 is prescribed.
- A simple TypeScript project should require no orb configuration file.
- Per-project machine sizing and arbitrary OS/package configuration are not part of the first slice.

### 3.4 Lifecycle

- We will implement stop/start and full restart recovery.
- We will not implement suspend/resume initially.
- The runtime should report health and busy/idle activity to the control plane.
- The control plane distinguishes an idle but healthy runtime from an unhealthy runtime. Failed health checks can lead to restart. The first vertical slice stops only on explicit requests; automatic idle stopping is deferred.
- Initial lifecycle constants are a 5-second running health poll, 30-second unreachable-runtime grace period, and 15-minute create/start deadline; all use injectable clocks and may be tuned later.
- Pi's `agent_settled` lifecycle state is a useful agent-idle signal because it means no retry, compaction retry, or queued continuation remains.
- How arbitrary detached/background processes affect idleness remains unresolved. We prefer not to introduce a special background-process tool if Pi or the operating system can provide a reliable signal.

### 3.5 Persistence

- The orb filesystem is assumed not to disappear. Containers, processes, and VMs may stop, crash, or be preempted, but the same persistent filesystem is available when the orb restarts.
- The filesystem is the authoritative persistence mechanism for the orb. Pi uses its normal persistent session file there.
- Conversation history is replicated to the control plane for immediate browsing and durable product history, but the replica is not used to reconstruct an orb or Pi session.
- Replication is pull-only in the first version. The control plane polls every active orb approximately every 10 seconds.
- Pulling and database persistence must not block the agent during normal operation.
- Temporary runtime, network, control-plane, or database failures are retried by the control plane from its last committed cursor.
- Immediately before a controlled stop, the control plane repeatedly pulls and commits history until the runtime returns no new complete records.
- Shutdown does not wait for Pi to settle. A user or parent agent may stop an orb during active work and accepts the risk of terminating an incomplete turn.
- If a pre-stop pull or database commit fails, the stop must not proceed; the control plane retries while leaving the host running.
- Cloud SQL for PostgreSQL is preferred over AlloyDB for the first cloud deployment because cheaper small configurations are sufficient for expected load.
- Local development should use a local PostgreSQL-compatible database, likely a Docker container.
- Database access must be behind an interface so tests can use an in-memory/fake implementation where appropriate and local/cloud deployments can select different adapters.

### 3.6 Deployment direction

- The cloud control plane is expected to run on Cloud Run.
- At least one Cloud Run instance must remain provisioned so active-orb history polling can run continuously.
- The polling process must use always-allocated CPU/instance-based billing; a minimum instance with request-only CPU allocation is insufficient for reliable background work.
- Polling state and cursors remain in PostgreSQL because Cloud Run may restart even a minimum instance at any time.
- Multiple control-plane instances may poll the same orb concurrently. Correctness uses an optimistic cursor compare-and-swap in the commit transaction rather than a distributed polling lock or leader.
- Infrastructure must be managed as code.
- The IaC tool is not decided.
- The control plane, orb runtime, shared protocol, and web UI will be written in TypeScript on Node.js 24.

### 3.7 Deterministic simulation testing

- Deterministic simulation testing is a first-class requirement from the beginning, not a later hardening phase.
- We will use the TypeScript [`determined`](https://www.npmjs.com/package/determined) package.
- Concurrency-critical domain code should accept its simulation/task abstractions so the same code runs with controlled scheduling and entropy in tests and `noSimulation` in production.
- Failing entropy traces must be recordable and exactly replayable.
- Explicit failpoints and scheduling checkpoints should cover replication, lifecycle, retry, reconciliation, and shutdown races.
- DST complements rather than replaces normal unit, database integration, Docker, browser, and eventual GCE tests.
- Deterministic virtual-time requirements are documented in [`DETERMINED-REQ.md`](DETERMINED-REQ.md).

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
type OrbHostState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "deleting"
  | "failed";

type OrbHostProviderOperation =
  | "provision"
  | "start"
  | "stop"
  | "destroy"
  | "observe"
  | "list";

interface OrbHostProviderError {
  type: "orb_host_provider_error";
  provider: string;
  operation: OrbHostProviderOperation;
  code: "unavailable" | "conflict" | "invalid_state" | "operation_failed";
  message: string;
  retryable: boolean;
}

interface OrbHostRef {
  provider: string;    // e.g. "docker" or "gce"
  resourceId: string;  // container ID, instance name, etc.
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
  ): ResultAsync<OrbHostRef, OrbHostProviderError>;

  /** Idempotent. */
  start(ref: OrbHostRef): ResultAsync<void, OrbHostProviderError>;

  /** Gracefully stops compute while retaining its filesystem. Idempotent. */
  stop(ref: OrbHostRef): ResultAsync<void, OrbHostProviderError>;

  /** Permanently removes the host and its filesystem. Idempotent. */
  destroy(ref: OrbHostRef): ResultAsync<void, OrbHostProviderError>;

  /**
   * Returns null only when the provider definitively reports that the
   * resource does not exist. Provider/transport uncertainty is Err.
   */
  observe(
    ref: OrbHostRef,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError>;

  /** Used for reconciliation and leaked-resource discovery. */
  listManagedHosts(): ResultAsync<OrbHostObservation[], OrbHostProviderError>;
}
```

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
  region: "us-central1",
  machineType: "n2d-highmem-4",
  debianImage: "<exact-image>",
  runtimeImage: "pi-orb-runtime:<digest>",
});
```

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

Expected initialization failures such as clone failure, invalid repository state, or unusable credentials are represented by `status: "failed"` long enough for the control plane to record the typed error. Unexpected process failure exits the process and is handled by provider supervision/reconciliation. Each provider configures its native runtime supervision while the host is meant to run (Docker restart policy initially, a system service on GCE later); an explicit provider `stop` disables/reconciles that supervision to stopped.

### 5.2 Lifecycle transitions

The database state is desired/reconciliation intent as well as user-visible state. Every transition uses `state_version` compare-and-swap; provider operations remain idempotent, so competing reconcilers are harmless.

| Database state | Reconciler behavior |
|---|---|
| `creating` | Ensure Codex auth, provision by orb ID, then wait for runtime ready. |
| `starting` | Ensure Codex auth, observe/start or reprovision the retained host/filesystem, then wait for runtime ready. |
| `running` | Poll provider/runtime health; broadcast/replicate normally. |
| `stopping` | Reject new live connections, close existing proxies, perform the final history-pull barrier, stop the provider host, then mark stopped. |
| `stopped` | Perform no runtime work; reconcile any unexpectedly running host back to stopped. |
| `failed` | Preserve filesystem and error; wait for an explicit start request. |

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
- a running provider whose runtime remains unreachable for a grace period is restarted with provider `stop`/`start`, without the controlled-stop drain because the runtime is already unhealthy;
- after OAuth completion, each blocked `creating`/`starting` row is CAS-reentered with a fresh `state_changed_at` before host work, so user login time does not consume the host startup deadline;
- an orb becomes `running` only after ready identity/session/commit data have been persisted;
- a controlled-stop pull/commit failure leaves the orb in `stopping` and the host running, as specified by the shutdown barrier;
- when stopping an orb that has never reached ready and has no `harness_session_id`, no user request could have been accepted, so the control plane may skip the history drain and stop the provider directly;
- if the provider is definitively absent during `stopping`, mark `stopped`; complete records left on the persistent filesystem are found on the next start.

Use initial constants of a 5-second running health interval, 30-second unreachable-runtime grace period, and 15-minute create/start deadline. These use injectable deterministic clocks. Time spent waiting for the user to complete a displayed OAuth device challenge ends when that challenge expires rather than consuming a separate hidden timeout.

Add `state_changed_at` to the orb row for transition deadlines; ordinary replication writes must not alter it. `updated_at` remains a general row-update timestamp.

No automatic idle stop is required for the first vertical slice. Manual stop exercises the full persistence barrier; idle/background-process policy can be added later without changing these transitions.

## 6. Harness-agnostic orb runtime protocol

The runtime protocol describes agent-runtime behavior rather than Pi behavior. A future Claude Code or Codex adapter should be able to implement the same contract.

A conceptual in-process client boundary is Result-based:

```ts
interface OrbRuntimeClient {
  health(): ResultAsync<RuntimeHealth, RuntimeClientError>;
  submit(input: RuntimeInput): ResultAsync<void, RuntimeClientError>;
  stopCurrentOperation(): ResultAsync<void, RuntimeClientError>;
  pullHistory(
    request: PullHistoryRequest,
  ): ResultAsync<PullHistoryResponse, RuntimeClientError>;
}
```

Persistence is deliberately separate: the control plane never derives replica writes from WebSocket frames. It polls the runtime's HTTP `pullHistory` endpoint and commits only the complete records returned there.

### 6.1 Transport and control-plane handoff

The browser opens `/api/orbs/{orbId}/live` only after the normal control-plane HTTP API reports the orb as running. It offers the WebSocket subprotocol `pi-orb.runtime.v1`.

The first slice performs no authentication or authorization at either hop. The control plane resolves the orb, opens its runtime WebSocket, then forwards text frames and close/backpressure signals without parsing application frames. It emits no control-plane data frame into the runtime stream. Runtime endpoints should still remain reachable only from the control plane's local Docker network so the browser topology does not accidentally become a direct-browser/runtime API.

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

JavaScript run-to-completion semantics prevent a Pi callback from interleaving while these frames are prepared and enqueued. There is no special catch-up queue, second barrier, or internal event watermark. The WebSocket writer still has the ordinary bounded output queue required for backpressure; if the complete synchronization batch cannot fit, close the connection and retry rather than interleave it with live events.

If `afterRecordId` is unknown, synchronization selects `mode: "full"` and replays all complete records. The UI upserts replayed records by ID.

There is deliberately no separate snapshot payload. Synchronization expresses the current operation as the same events used for live updates, with `replace` patches where complete accumulated state is needed. This keeps one reducer and one event model. `sync.started` tells the browser to clear transient state before applying the reconstructing events.

This provides reconnect without retaining a token-delta replay log. The resume cursor is a durable history record ID, while replayed ordinary events reconstruct transient work.

### 6.3 Frame union

Keep the top-level union small. The browser sends only a hello or a request; message-delivery variants live inside one request action.

```ts
type ClientFrame = ClientHello | ClientRequest;

type ClientAction =
  | {
      type: "message";
      delivery:
        | { type: "new"; expectedHeadId: string | null }
        | { type: "steer"; operationId: string }
        | { type: "follow_up"; operationId: string };
      content: Array<{ type: "text"; text: string }>;
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

`expectedHeadId` prevents a stale tab from silently starting a turn against a different conversation head. Requiring an operation ID prevents a delayed steer, follow-up, or abort from affecting a later operation. An operation is one continuous busy period from an accepted new message until the runtime returns to idle; steering and queued follow-ups remain part of that operation.

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
    | QueueStateEvent
    | OperationFinishedEvent;
}

interface OutputPatchEvent {
  type: "output_patch";
  operationId: string;
  blockId: string;
  blockType: "text" | "reasoning";
  revision: number;
  patch:
    | { type: "append"; text: string }
    | { type: "replace"; text: string };
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

interface QueueStateEvent {
  type: "queue_state";
  operationId: string;
  pending: Array<{
    requestId: string;
    delivery: "steer" | "follow_up";
    content: Array<{ type: "text"; text: string }>;
  }>;
}
```

Complete records use `history.record` both during synchronization and live operation. They improve UI responsiveness, but the control plane ignores them for persistence. A successful `operation_finished` event is sent only after all complete history records caused by that operation have been emitted.

No application-level ping frame is needed. The runtime and proxy use WebSocket protocol ping/pong for dead-peer detection; browsers respond to protocol pings automatically. Runtime status/health remains ordinary state, not a ping substitute.

All schemas will be closed TypeBox schemas. An invalid request receives a rejected `request.result` where its request ID can be recovered, otherwise `server.error`. A v1 browser should ignore a well-formed unknown server event so optional capabilities can be added without breaking old clients.

### 6.4 Ordering, request identity, and backpressure

WebSocket ordering is sufficient within one connection, so frames do not have an event sequence number. Synchronous hello preparation creates the synchronization boundary. Reconnection uses complete record IDs and reconstructed live events, not a socket event offset.

`client.hello` is non-mutating: it observes and synchronizes state. Both request actions are mutating: `message` can start or alter agent work, and `abort` changes a running operation. HTTP health and history pulls are also non-mutating from the runtime's perspective. Control-plane host start/stop operations are mutations in a different API.

Use Pi's own append-only session ledger as the durable request inbox rather than creating a separate file or database. Immediately before handing a mutating action to Pi, append a `CustomEntry` like:

```ts
interface PiOrbRequestEntry {
  customType: "pi-orb.request";
  data: {
    requestId: string;
    operationId: string;
    actionType: "message" | "abort";
    actionHash: string;
  };
}
```

The runtime serializes mutating requests, so this marker and the subsequent Pi entries have an unambiguous order. On startup it scans `pi-orb.request` entries to rebuild the request index. Reusing an ID with a different action hash returns `request_id_conflict`.

Pi's current ordinary `SessionMessageEntry`/`UserMessage` types have no request-metadata field, so the ID cannot be attached directly to a normal user message without changing Pi. A custom marker is preferable to substituting `CustomMessageEntry`, because custom messages bypass parts of Pi's normal user-prompt preprocessing and extension path.

The marker and action are still separate appends, but Pi's ordering makes the crash gap recoverable for messages:

- The Pi adapter uses `AgentSession.sendUserMessage`, not Pi slash-command dispatch.
- Pi awaits the user message's `message_end`, and `AgentSession` appends that message to the session, before model response streaming begins.
- Marker plus corresponding user entry means the request was durably delivered.
- Marker without a corresponding user entry after a runtime restart means the message did not reach the model. A new-message action may be safely resumed with the same request ID if its expected conversation state is otherwise unchanged.
- A delivered steer/follow-up similarly appears as a user entry before the next model call. A still-pending one is represented in live `queue_state`; if the process dies first, it never affected the model. Because its target operation no longer exists after restart, report `stale_operation` rather than silently converting it into a new message.
- For abort, a restarted process has already terminated the targeted operation, so replaying the old abort is unnecessary; treat it as satisfied. In a surviving process, the in-memory request state resolves it.

The browser may resend the same unacknowledged request ID and identical action after reconnect. The runtime consults the rebuilt Pi-ledger index and current in-memory state to return the previous acceptance, safely resume an undelivered new-message action, report a stale target, or reject conflicting reuse. This is harness-adapter behavior: another harness must provide an equivalent durable request marker/correlation mechanism or advertise that reconnect retry is unsupported.

Under outbound pressure, transient output and tool-state events may be coalesced to their newest equivalent state. Welcome, synchronization boundaries, request results, complete history records, operation transitions, and errors are never intentionally dropped. If critical queued data exceeds the configured budget, the runtime closes the connection and the browser reconstructs state through a new handshake.

Harness capabilities differ. `server.welcome.capabilities` initially advertises values such as `steer`, `follow_up`, `abort`, and `input.image`; unsupported actions are rejected explicitly.

### 6.5 Multiple connections

Naturally support multiple simultaneous WebSocket connections to one orb. Each connection performs its own cursor-based synchronization and has its own bounded outbound writer. Complete history, runtime events, and status are broadcast; `request.result` is sent only to the requester.

All mutating requests from all connections pass through one runtime serial executor. `expectedHeadId`, operation IDs, and durable request IDs make races explicit: for example, two new-message requests against the same head cannot both succeed. This is not a commitment to multiplayer product features—there is no presence, attribution, shared editor state, or per-user permission model—but browser reloads and multiple tabs do not evict each other.

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
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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

type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "developer"
  | "tool";

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
- Every persisted harness entry after `after`, including internal `pi-orb.request` custom entries, maps one-to-one to a `HistoryRecord`; the adapter must not skip entries that would break cursor continuity.
- Records are returned in harness append order and parent-before-child order.
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

`orbId` detects host-routing mistakes. `session.id` is Pi's session UUID and prevents records from a replacement session being merged into the same orb replica. The session header is metadata rather than a history record, so it never changes the cursor or entry ancestry. The first successful pull stores the complete metadata on the orb row; every later pull must match it exactly.

The control plane commits each non-empty response transactionally: verify immutable session metadata and duplicate rows, insert new records, update `replicated_head_id`, and advance `replication_cursor` with cursor compare-and-swap. An empty response may still initialize/verify session metadata, but does not advance the cursor. If the transaction fails, the cursor does not advance and the next poll requests the same range again.

No cursor is stored inside every history record, and Pi does not need a separate runtime outbox or replication journal. Its authoritative session history already provides the durable records and append order needed by the pull adapter.

### 8.2 Polling and retries

The control plane is solely responsible for scheduling persistence work:

- poll every active orb at roughly a 10-second interval;
- after a non-empty response, it may pull again immediately to reduce lag;
- retry runtime, network, and database failures from the unchanged committed cursor;
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

“Content-agnostic” does not mean blind TCP forwarding: the control plane still owns host startup, routing, connection limits, and protocol-version negotiation. Authentication and authorization will also belong at this boundary when added after the first slice. The control plane does not parse runtime application frames after handoff.

### 8.4 Controlled shutdown pull barrier

Shutdown does not wait for Pi to settle. The requesting user or parent agent accepts the risk of interrupting active work.

Before stopping the host, the control plane:

1. pulls after its current committed cursor;
2. commits the response and advances the cursor atomically;
3. repeats while each pull returns one or more records;
4. when a pull returns no new complete records, immediately requests host stop.

If a pull or database commit fails, the stop does not proceed; the control plane retries while leaving the host running.

An in-progress record is intentionally omitted. If shutdown terminates the process before that record becomes complete, it is not replicated; this is part of the caller-accepted interruption risk. A complete record committed in the narrow race after the final empty pull and before process termination remains on the authoritative filesystem and will be discovered after the next start.

### 8.5 Reconciliation and failure model

The filesystem is assumed to survive process, container, VM, and Spot failures. After restart, polling resumes from the database cursor and discovers remaining complete harness records.

For Pi, the adapter can enumerate every persisted entry. A full ID-based reconciliation endpoint or diagnostic mode may still be useful as a backstop if the stored cursor is invalid or the adapter/session disagree, but it is not required to reconstruct the orb.

The replica is explicitly **not** an orb backup or reconstruction source. If an orb is intentionally destroyed, its replicated history may remain browsable according to retention policy, but that history is not used to recreate the deleted filesystem or resume the Pi session.

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
sessionManager.getHeader();   // session metadata
sessionManager.getEntries();  // all entries, including pre-compaction
sessionManager.getTree();     // full tree, including abandoned branches
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

| Pi persisted entry | Normalized record |
|---|---|
| `message` / user | `MessageRecord`, role `user`; text/image blocks. |
| `message` / assistant | `MessageRecord`, role `assistant`; text, thinking→reasoning, and tool-call blocks; provider/model, usage, stop reason. |
| `message` / tool result | `MessageRecord`, role `tool`; one typed `tool_result` block containing call ID, nested text/image content, and error flag. |
| `message` / bash execution | `EventRecord`, `eventType: "pi.bash_execution"`; normalized textual content where useful. |
| `thinking_level_change` | `EventRecord`, `eventType: "pi.thinking_level_change"`. |
| `model_change` | `EventRecord`, `eventType: "pi.model_change"`. |
| `compaction` | `CompactionRecord`; summary as a text block, with first-kept ID/token/details retained natively. |
| `branch_summary` | `EventRecord`, `eventType: "pi.branch_summary"`, with summary text content. |
| `custom` / `pi-orb.request` | `EventRecord`, `eventType: "pi-orb.request"`. |
| other `custom` | `EventRecord`, `eventType: "pi.custom"`. |
| `custom_message` | `EventRecord`, `eventType: "pi.custom_message"`, with text/image content; retain `customType`, `display`, and details natively. |
| `label` | `EventRecord`, `eventType: "pi.label"`. |
| `session_info` | `EventRecord`, `eventType: "pi.session_info"`. |
| unknown future entry | `EventRecord`, `eventType: "pi.<native-type>"`. |

Content conversions are direct and lossless through native overflow:

- Pi text → `ContentBlock { type: "text" }`;
- Pi image `mimeType`/base64 data → normalized `mediaType`/data;
- Pi thinking text → `ContentBlock { type: "reasoning" }`;
- Pi tool call ID/name/arguments → typed `tool_call`;
- Pi tool-result call ID/content/error → typed `tool_result`;
- assistant provider/model/usage/cost/stop reason → normalized model, usage, and `finishReason` fields.

An unknown message role maps to a generic event rather than inventing a shared role. A mapping/validation failure returns a typed history error and makes `pullHistory` fail; it must never silently omit an entry.

### 9.3 Completeness and cursor continuity

`SessionManager.getEntries()` is the sole Pi replication source. Pi appends user/tool/assistant messages on awaited `message_end`; streaming `message_update` state is not present there and is never synthesized into persistence.

Every returned persisted entry maps one-to-one to exactly one record and advances the native-ID cursor exactly once. This includes labels, hidden custom entries, and `pi-orb.request` markers. Unknown future types still become generic events, preserving cursor continuity across Pi upgrades.

### 9.4 Initial UI visibility

Visibility is presentation policy, not persistence filtering:

- show user and assistant messages normally; show tool names and states while keeping tool inputs and outputs collapsed by default;
- show compaction as a collapsed boundary;
- show `pi.custom_message` only when native `display` is true;
- hide model/thinking changes, branch summaries, bash-execution events, labels, session-info entries, ordinary custom entries, and unknown events by default;
- always hide `pi-orb.request` markers.

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

## 11. Projects, source checkout, and first end-to-end slice

### 11.1 Project model

The first version is fully web-driven and does not require a local checkout or CLI.

A user registers a project in the web UI with:

- a project name;
- a public Git repository URL.

Starting an orb for the project performs a fresh clone into the orb filesystem. There is no local upload, dirty-state patch, sync-back workflow, clone cache, prepared snapshot, or other checkout optimization initially. The initial clone uses the repository's default branch; the resolved commit should be recorded for observability.

The first version should accept only explicitly supported public HTTPS Git URLs. Validation must prevent local paths, `file://` URLs, credential-bearing URLs, and network targets that could turn cloning into SSRF or internal network access.

The environment is prescribed initially:

- Debian 12;
- Node.js 24;
- fixed orb runtime/container image;
- Spot `n2d-highmem-4` on GCE later;
- no required orb configuration for a simple TypeScript project.

Still open:

- which public Git hosts and URL forms are allowed;
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
  state:
    | "creating"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "failed";
  stateVersion: number;
  checkoutCommit?: string;
  lastError?: string;
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

Do not expose `host_ref`, model credentials, harness session ID, or internal replication fields in `OrbView`. `actionRequired` is synthesized from the current in-memory device flow and can contain only its public challenge; it is not stored in the orb row. The dedicated history response exposes only the cursor/head needed for live handoff.

Status behavior:

- project creation returns `201`;
- orb creation and start/stop requests return `202` with the current `OrbView`;
- before creating/starting the host, the backend resolves and refreshes Codex OAuth; if user interaction is required, the orb remains in `creating`/`starting` and the response returns the device-login challenge in `actionRequired`;
- the browser polls only the normal orb resource, not an auth resource; when login succeeds the backend resumes lifecycle work automatically;
- lifecycle endpoints are idempotent when already moving toward or in the requested state;
- lifecycle work is asynchronous and recoverable from `orbs.state`; the browser polls `GET /api/v1/orbs/:orbId`;
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

The [`determined`](https://www.npmjs.com/package/determined) package provides cooperative deterministic scheduling, reproducible entropy, failpoints, mutexes, condition variables, deadlock detection, and exact record/replay of failing schedules.

The architecture should keep side effects behind adapters and put concurrency/state-machine logic in simulation-compatible code. Initial high-value simulation targets are:

- repeated and delayed history pulls;
- runtime or database failure before a poll transaction commits;
- a polling worker crashing immediately before or after commit;
- overlapping pollers reading the same orb cursor;
- incomplete streaming records becoming complete between pulls;
- history load racing with live subscription;
- parent records arriving after children;
- controlled stop racing with newly completed agent output;
- busy and health heartbeats racing with stop/restart decisions;
- repeated provider operations and control-plane recovery after partial failure;
- concurrent orb starts sharing one OAuth device flow, OAuth completion/failure, and restart while login is pending;
- multiple reconcilers observing and acting on the same orb.

Simulation tests should:

1. run many entropy-driven schedules and failpoint combinations;
2. save the full entropy trace and relevant test configuration on failure;
3. verify that the saved trace reproduces the same failure;
4. make replaying a captured failure a simple test command;
5. assert invariants, not only expected happy-path outputs.

Important invariants include no cursor advancement without the corresponding database commit, stable native record IDs across repeated pulls, no omission of complete records after a cursor, no return of incomplete records, idempotent retries, no host stop after a failed pre-stop pull, at most one authoritative host per orb, and no transition from a failed health observation directly into an idle stop decision.

`determined` controls cooperative scheduling and entropy, but not wall-clock time or external systems by itself. Core code will also need injectable clocks/timers and simulated adapters for the database, runtime transport, and host provider. Real integration tests remain responsible for validating adapter behavior.

## 15. Security requirements and questions

The first local vertical slice intentionally has no authentication or authorization. Anyone who can reach the control plane can list, create, inspect, control, stop, and delete every project and orb. The control plane-to-runtime hop is also unauthenticated. This deployment is suitable only on a trusted development machine/network and must not be exposed publicly.

### 15.1 First-slice OpenAI Codex OAuth credentials

The initial provider is hardcoded to Pi's built-in `openai-codex`, using a ChatGPT Plus/Pro subscription rather than an OpenAI API key. There are no model/provider/thinking-level environment variables or model-selection controls in the first slice. The runtime uses Pi's built-in default Codex model and default thinking level; explicit model selection can be added only when the product needs it.

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

For local Docker, use Pi's standard `AuthStorage` with `auth.json` on one dedicated persistent control-plane-owned Docker volume, for example:

```text
pi-orb-auth:/var/lib/pi-orb/auth
/var/lib/pi-orb/auth/auth.json   # mode 0600
```

The `DockerOrbHostProvider` mounts that credential volume at the same private path in the control-plane container and every orb runtime container, separately from each orb's project/session volume. This Docker mechanism is private provider configuration and does not appear in control-plane lifecycle logic or the `OrbHostProvider` contract. Each `ModelRuntime` uses `AuthStorage` pointed at that file. Pi's `CredentialStore.modify` and file lock serialize read-refresh-write across processes, so concurrent orbs do not independently rotate the same refresh token. The runtime receives no credential environment variable and no copied per-orb token.

Do not write OAuth credentials to PostgreSQL, images, project volumes, Pi session history, logs, or HTTP responses. No browser-facing response type imports or contains Pi's stored credential type; `OrbView.actionRequired` can represent only the public device-login challenge. Add a response-schema test that fails if `access` or `refresh` can be serialized.

This shared file is intentionally the simplest local implementation, not a security boundary. Orb code may be able to read the mounted subscription credential, and anyone able to request orb creation/start may trigger the global login flow. The first slice therefore trusts all users and repository code. Before GCE/public deployment, replace the file implementation behind Pi's `CredentialStore` interface with a control-plane credential broker or managed-secret-backed store so refresh tokens are never mounted into orbs.

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

- `typescript`;
- `vite` and `@vitejs/plugin-react`;
- `eslint` and `typescript-eslint`, primarily to enforce the no-throw and unsafe-boundary rules;
- `prettier`;
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
2. Validate Cloud Run WebSocket proxy duration, reconnect, backpressure, and cost behavior.

### Replication and history

3. Define stable adapter-generated IDs for harnesses that do not provide native record IDs.
4. Define polling retry/backoff policy and the exact SQL transaction implementing cursor compare-and-swap.
5. Define behavior when a child record arrives before its parent.
6. Compare real Claude Code and Codex persisted history examples before freezing the normalized schema.
7. Decide which additional record variants deserve static types beyond message, compaction, and generic event.
8. Decide how to replicate and store images, large outputs, truncated outputs, patches, and artifacts.
9. Define what the UI indicates, if anything, when live history is newer than the replica.
10. Decide whether and how to perform occasional full ID-based reconciliation when a cursor becomes invalid.

### Lifecycle and background work

11. Determine what Pi exposes about running/detached background processes before future automatic idle stopping.
12. Determine whether ordinary OS process/cgroup inspection is reliable enough to avoid a custom background-job tool.
13. Decide whether a browser connection prevents future automatic idle shutdown.
14. Define how a pending stop and persistence retry are presented to the requester.

### Project and environment

15. Choose the allowed public Git hosts and exact HTTPS URL validation rules.
16. Define clone failure handling, default-branch behavior, and recorded repository metadata.
17. Choose the exact pinned Debian image and Node 24 release/update policy.
18. Decide whether to adopt `.agents/setup` and a restart hook inspired by Amp.
19. Decide how setup caching/prebuilt snapshots work after the unoptimized first slice.
20. Decide which tools and services are installed in the prescribed base image.
21. Decide if/when an Orbfile is introduced and what it is allowed to configure.
22. Decide how services, ports, logs, browser automation, and preview URLs work.

### Control plane, database, and deployment

23. Define the abstract history repository/database interface.
24. Choose the IaC tool for Cloud Run, Cloud SQL, networking, IAM, Artifact Registry, and GCE.
25. Decide how to partition polling later if redundant all-orb polling becomes inefficient at scale; no leader or partitioning is needed initially.
26. Define Cloud Run-to-orb networking and runtime authentication.
27. Define observability, audit logging, metrics, and cost attribution.
28. Define orphan-host reconciliation and cleanup.

### Product and security

29. Define the future user/project/orb identity and authorization model before public deployment.
30. Define future per-user/project model credentials and private-Git credentials/workload identity.
31. Define project trust and the security boundary for repository-controlled code.
32. Define orb deletion/export behavior and retention of replicated history.
33. Define whether stopped hosts have an expiration/garbage-collection policy.
34. Define the eventual suborb orchestration and filesystem handoff model.

### Testing

35. Define the simulation boundary and shared test harness for control-plane state machines.
36. Define CI iteration budgets and storage/replay conventions for failing entropy traces.
37. Decide which virtual-time API requirements in [`DETERMINED-REQ.md`](DETERMINED-REQ.md) belong in `determined` itself versus a pi-orb wrapper.
