# Harness-agnostic orb runtime protocol

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

## Transport and control-plane handoff

The browser opens `/api/orbs/{orbId}/live` only after the normal control-plane HTTP API reports the orb as running. It offers the WebSocket subprotocol `pi-orb.runtime.v1`.

The first slice performs no authentication or authorization at either hop. The control plane resolves the orb, opens its runtime WebSocket, then forwards text frames and close/backpressure signals without parsing application frames. Because the browser sends `client.hello` immediately after its upgrade completes, the proxy installs browser message handlers synchronously before awaiting orb lookup or host observation, queues text frames during routing, and flushes them in order once the runtime socket opens. It emits no control-plane data frame into the runtime stream. Runtime endpoints should still remain reachable only from the control plane's local Docker network so the browser topology does not accidentally become a direct-browser/runtime API.

A connection race or unavailable runtime closes with `1013 Try Again Later`; the browser returns to the HTTP lifecycle API before retrying. Binary frames are not accepted.

This makes the runtime's `client.hello` the first application frame and avoids two nested handshakes or mixed control-plane/runtime frame namespaces. Authentication can later be added at the HTTP/WebSocket upgrade and control-plane-to-runtime connection without changing agent frames.

## Handshake and synchronization

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

## Frame union

Keep the top-level union small. The currently implemented browser protocol sends a hello or a request. Its `message` action is running-runtime-only. The send-anytime design below moves browser user messages out of this live mutation path rather than adding `steer` and `follow_up` wire variants; shell and abort remain live-only requests.

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
      type: "shell";
      expectedHeadId: string | null;
      command: string;
      excludeFromContext: boolean;
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

`expectedHeadId` prevents a stale tab from silently starting a turn or shell command against a different conversation head. Requiring an operation ID prevents a delayed abort from affecting a later operation. An operation is one continuous busy period from an accepted new message or shell command until the runtime returns to idle. Under the send-anytime design, a message delivered while busy steers and joins the active operation; a message delivered while idle starts a new operation.

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
    | OperationFinishedEvent
    | TurnNotificationEvent;
}

interface OutputPatchEvent {
  type: "output_patch";
  operationId: string;
  blockId: string;
  blockType: "text" | "reasoning" | "shell";
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

Agent turns may later emit a live-only `turn_notification { operationId, summary }` runtime event. The Luna summary starts only after `operation_finished` and idle status have been broadcast, so inference never delays completion and failure can only be error-logged. This event is presentation data: it is not a Pi history record, is not replicated or replayed during synchronization, and is simply lost when no browser is connected. Shell operations do not produce it (decided 2026-08-06).

No application-level ping frame is needed. The runtime and proxy use WebSocket protocol ping/pong for dead-peer detection; browsers respond to protocol pings automatically. Runtime status/health remains ordinary state, not a ping substitute.

All schemas will be closed TypeBox schemas. An invalid request receives a rejected `request.result` where its request ID can be recovered, otherwise `server.error`. A v1 browser should ignore a well-formed unknown server event so optional capabilities can be added without breaking old clients.

## Ordering, request identity, and backpressure

WebSocket ordering is sufficient within one connection, so frames do not have an event sequence number. Synchronous hello preparation creates the synchronization boundary. Reconnection uses complete record IDs and reconstructed live events, not a socket event offset.

`client.hello` is non-mutating: it observes and synchronizes state. All request actions are mutating: `message` starts agent work, `shell` starts a foreground command, and `abort` changes a running operation. HTTP health and history pulls are also non-mutating from the runtime's perspective. Control-plane host start/stop operations are mutations in a different API.

Request identity is in-memory and scoped to one runtime process. The runtime keeps a map from request ID to its action and outcome for the life of the process. Resending a known request ID with an identical action returns the original result with `duplicate: true`; reusing a known ID with a different action returns `request_id_conflict`; an abort naming a finished or unknown operation returns `stale_operation`.

A runtime restart empties that map, and `server.welcome.runtimeInstanceId` tells the browser so. After reconnecting, the browser may automatically resend an unacknowledged request only when `runtimeInstanceId` matches the instance that received it. When the instance has changed, the browser relies on synchronization instead: the Pi adapter uses `AgentSession.sendUserMessage`, and Pi appends an accepted user message to the session on its awaited `message_end`, before model streaming begins, so a delivered message always appears in the replayed history. If it appears, the request was delivered; if it does not, it never reached the model, and the user decides whether to send it again as a new request.

There is deliberately no durable inbox for the currently implemented live-only shell and abort requests. The earlier generic `pi-orb.request` marker proposal remains rejected: it doubled every mutation with a hidden record and was unnecessary for live-only delivery.

The send-anytime inbox changes the premise for **user messages only**. A stopped runtime cannot own a queue, and accepting a message before startup requires durable control-plane state plus restart-stable delivery identity. The design therefore uses one Pi custom-message record as the delivered user message itself—not a marker plus a second record. Its native details carry every control-plane message ID in that delivery batch, it is mapped and rendered as an ordinary user message, and its content is ordinary model context. This gives one durable record per delivered batch and lets a restarted runtime recognize delivery without duplicating it.

Under outbound pressure, transient output and tool-state events may be coalesced to their newest equivalent state. Welcome, synchronization boundaries, request results, complete history records, operation transitions, and errors are never intentionally dropped. If critical queued data exceeds the configured budget, the runtime closes the connection and the browser reconstructs state through a new handshake.

Harness capabilities differ. `server.welcome.capabilities` initially advertises values such as `abort` and `input.image`. In the send-anytime design, steering is an internal delivery choice behind the control-plane message API rather than a browser-selected live capability; a future product that exposes an explicit steer/follow-up choice could still add capabilities without a wire-version change. User-shell execution is mandatory in the current Pi runtime contract rather than capability-gated; if a second harness without an equivalent operation is introduced, revisit that contract from concrete adapter evidence. Unsupported actions are rejected explicitly.

`input.image` is implemented end to end (2026-08-01): the browser composer accepts pasted images and sends them as `image` input blocks, the runtime forwards them to Pi's `sendUserMessage` as native image content (`mediaType` → Pi's `mimeType`), and they replicate losslessly through the ordinary history path like any other Pi-persisted content. To accommodate base64 payloads, the runtime's limits are 8 MiB per incoming frame and 6 MiB per prompt (`server.welcome.limits` remains authoritative for clients; the browser enforces the limit at paste time).

## Send-anytime message inbox (decided and implemented 2026-08-10)

### One ingress path

Every agent **message**, whether the orb is busy, idle, starting, or stopped, should enter through one idempotent control-plane HTTP command. The browser must not choose between “send”, “steer”, and “queue”, and must not race an HTTP offline path against the live WebSocket path. Shell and abort remain live-only because a shell command requires an idle checkout and abort names a current operation.

The browser generates a message UUID and uses `PUT /api/v1/orbs/{orbId}/messages/{messageId}`. A successful `202` means the message is durably accepted in PostgreSQL, not that Pi has consumed it. Repeating the same ID and identical body returns the same resource; different content conflicts. The live WebSocket remains the ordered history/transient-output channel and no longer carries new message actions once this proposal is implemented.

This is a deliberate narrowing of the content-agnostic proxy, not a second message path: message content terminates at the finite control-plane command endpoint, while the long-lived live proxy still does not inspect runtime→browser agent frames. Stretching `/live` so it remains open while no runtime exists was rejected: the control plane would have to impersonate the runtime handshake, retain frames, switch ownership during startup, and recover socket-local acceptance after process death.

### Durable FIFO and lifecycle wake

The control plane stores a per-orb FIFO inbox row containing the client message ID, validated content blocks, insertion order, status, and a sanitized delivery error. Inbox insertion and any lifecycle wake intent commit atomically. `creating`, `starting`, and `running` need no extra lifecycle transition. A stopped or failed orb enters the ordinary `starting` path; a message accepted during `stopping` records a restart-after-stop wake, and the normal stop drain completes before startup. An explicit stop linearized after a message clears that wake and leaves undelivered messages queued; a later message sets it again. Thus an explicit stop is not defeated by an immediate automatic bounce, while a send linearized after stop still starts the orb.

Delivery is strict FIFO with batching (decided 2026-08-10). When dispatch becomes possible, the store atomically freezes every message currently queued behind the head into one batch identified by the first message ID. Their content is squashed into one user message in FIFO order with one empty line (`\n\n`) between submissions; text and image blocks otherwise remain lossless. Messages admitted after the batch claim form the next batch and can never alter an in-flight retry's payload. Head-of-line blocking is intentional: it provides one obvious conversation order and avoids overtaking an ambiguous transport outcome. Terminal startup or delivery failure remains visible on every constituent message resource and does not silently discard a row.

### Atomic runtime delivery choice

The existing per-orb reconciler is the dispatcher: inbox commit wakes it immediately, and later ordinary scans recover work after process death. No broker, queue service, or fourth background loop is added. When the orb is running it calls an authenticated, idempotent runtime HTTP operation keyed by the durable batch ID and carrying all constituent message IDs. The runtime serializes it through the same mutation executor as live shell and abort requests, then chooses from its authoritative activity at that instant:

- busy agent operation → call Pi with `deliverAs: "steer"` and associate the message with the existing operation;
- idle runtime → trigger an ordinary new agent turn and allocate a new operation ID;
- active shell operation → keep the message pending until the shell is idle; steering a shell has no defined meaning.

The choice is state-derived, not browser-selected and not based on the control plane's lagging ~10-second activity observation. Consequently the API has one message shape and no `delivery` input enum. The result/status may report the observed delivery mode for explanation.

`expectedHeadId` is intentionally absent from this command. A durable FIFO is append intent: concurrent tabs are ordered by database admission, and messages queued behind another message cannot all validly name the same eventual Pi head. Checking the replica head would also be unsound because live history may be ahead of PostgreSQL. The stale-head gate remains useful for live shell commands, whose effect must apply to the checkout at a specifically observed idle head.

### Exactly-once logical message without a second marker

PostgreSQL is authoritative before delivery; Pi's session file is authoritative after delivery. A finite HTTP acknowledgement cannot atomically commit both stores, so request IDs held only in runtime memory are insufficient: a crash after Pi appends but before the control plane marks delivery would otherwise duplicate the message.

For Pi, deliver the squashed batch as one `custom_message` with `customType: "pi-orb.user-message"`, `display: true`, the combined text/image content, and `details.messageIds`. `triggerTurn: true` plus `deliverAs: "steer"` implements the busy case; idle delivery triggers a normal turn. The Pi adapter maps this particular custom type to normalized `MessageRecord { role: "user" }` rather than to a generic event. It therefore looks and behaves like today's user message, enters model context as a user message, and costs no extra history record.

The runtime checks both persisted session entries and its in-memory pending-batch-ID set before enqueueing. A retry finds one of three states: persisted means the whole frozen batch was delivered; pending in this runtime means still queued; absent means safe to enqueue (including after a restart that lost Pi's in-memory steering queue). The control plane marks every constituent inbox item delivered when the corresponding history record is replicated, in the same transaction as that record. This closes acknowledgement-loss and runtime-restart races without pretending to provide a cross-database transaction.

Other harness adapters must provide the same durable client-message identity in their native record or a sidecar ledger on the authoritative orb filesystem. If a harness cannot do that, its capability must reject durable offline acceptance rather than silently weakening to duplicate-prone delivery.

### Observability and deterministic tests

Queued messages are user-visible resources: `GET .../messages` restores their durable statuses after reload, and the UI shows each outstanding item once as a muted user turn with queued/steering state while delivery is pending, then removes those provisional turns when the runtime record carrying their message IDs arrives; several gray turns may therefore collapse into one committed squashed user turn. Autonomous wake and dispatch decisions produce edge-only `lifecycle:` records containing orb ID and message ID but never message content. Required deterministic schedules include send-versus-stop, idle-stop-versus-send, two control-plane dispatchers, crash before Pi enqueue, crash after enqueue but before persistence, crash after persistence but before acknowledgement, and FIFO delivery across boot. The runtime protocol/browser E2E must cover stopped submission → startup → delivered history and busy submission → steer.

## User shell operations

Decided 2026-08-05: a browser shell submission is an explicit `shell` action, not a `message` whose leading characters the runtime interprets. This keeps validation, request identity, stale-head checking, and future harness adaptation explicit while the control plane remains content-agnostic. Shell support is mandatory for the current Pi runtime and is not advertised as an optional capability.

A shell command is a serialized foreground operation. It is accepted only while the runtime is idle and `expectedHeadId` matches, receives an operation ID, and marks activity busy synchronously at acceptance. The runtime records the active operation kind: abort dispatches agent work to the harness's agent-abort operation and shell work to its shell-abort operation. A cancelled command finishes with operation outcome `aborted`. A nonzero exit is a completed operation with an unsuccessful command and visible exit code; only harness/runtime failures use operation outcome `failed`.

Live shell output uses `output_patch` with `blockType: "shell"`. The block is preformatted as `$ <command>` plus streamed output, bounded using the shell-output safety limit, and participates in the existing coalescing and reconnect reconstruction path. `LiveOperationView` retains the active operation kind and bounded shell block so the ordinary synchronous handshake reconstructs an in-flight command. The complete persisted history record must be emitted before `operation_finished`, just as it is for agent operations.

A shell action never carries image input. The browser prevents such submission, and the runtime schema/action handler rejects malformed attempts defensively. Command input uses the existing incoming-frame/prompt-size safety envelope.

## Separate interactive-terminal socket (decided and implemented 2026-08-09)

The interactive orb terminal is intentionally not part of this agent frame union. The browser opens `/api/v1/orbs/{orbId}/terminal` with subprotocol `pi-orb.terminal.v1`; the control plane observes the same runtime address and proxies it to private runtime endpoint `/v1/terminal`. JSON text controls open/resize the PTY and report ready/exit/typed errors, while binary frames carry UTF-8 input/output. It has no agent hello, history cursor, request identity, persistence, replay, or model-context semantics. See `docs/terminal.md` for the complete contract and rationale.

## Multiple connections

Naturally support multiple simultaneous WebSocket connections to one orb. Each connection performs its own cursor-based synchronization and has its own bounded outbound writer. Complete history, runtime events, and status are broadcast; `request.result` is sent only to the requester.

All mutating requests from all connections pass through one runtime serial executor. `expectedHeadId`, operation IDs, and request IDs make races explicit: for example, two new-message requests against the same head cannot both succeed. This is not a commitment to multiplayer product features—there is no presence, attribution, shared editor state, or per-user permission model—but browser reloads and multiple tabs do not evict each other.

If a later deployment needs a single-connection policy, enforce it in the runtime rather than the control plane: atomically replace the active connection on a successful new hello and close the previous socket with a private replacement close code. Runtime enforcement works even with multiple control-plane instances. The first slice does not impose this restriction.
