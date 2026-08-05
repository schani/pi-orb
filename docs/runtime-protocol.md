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

## Ordering, request identity, and backpressure

WebSocket ordering is sufficient within one connection, so frames do not have an event sequence number. Synchronous hello preparation creates the synchronization boundary. Reconnection uses complete record IDs and reconstructed live events, not a socket event offset.

`client.hello` is non-mutating: it observes and synchronizes state. Both request actions are mutating: `message` starts agent work, and `abort` changes a running operation. HTTP health and history pulls are also non-mutating from the runtime's perspective. Control-plane host start/stop operations are mutations in a different API.

Request identity is in-memory and scoped to one runtime process. The runtime keeps a map from request ID to its action and outcome for the life of the process. Resending a known request ID with an identical action returns the original result with `duplicate: true`; reusing a known ID with a different action returns `request_id_conflict`; an abort naming a finished or unknown operation returns `stale_operation`.

A runtime restart empties that map, and `server.welcome.runtimeInstanceId` tells the browser so. After reconnecting, the browser may automatically resend an unacknowledged request only when `runtimeInstanceId` matches the instance that received it. When the instance has changed, the browser relies on synchronization instead: the Pi adapter uses `AgentSession.sendUserMessage`, and Pi appends an accepted user message to the session on its awaited `message_end`, before model streaming begins, so a delivered message always appears in the replayed history. If it appears, the request was delivered; if it does not, it never reached the model, and the user decides whether to send it again as a new request.

There is deliberately no durable request inbox. An earlier proposal appended a `pi-orb.request` custom marker entry to Pi's session ledger before each mutating action so that unacknowledged requests could be resumed exactly-once across runtime restarts. It was rejected as disproportionate: the shutdown model already accepts losing an in-flight turn, the markers doubled the persisted records per send and moved the conversation head onto hidden entries, and the residual risk — a blind resend across a runtime restart — is prevented by the instance-ID rule above. A future harness adapter therefore needs no durable request marker or correlation mechanism; it only needs a stable per-process runtime instance ID.

Under outbound pressure, transient output and tool-state events may be coalesced to their newest equivalent state. Welcome, synchronization boundaries, request results, complete history records, operation transitions, and errors are never intentionally dropped. If critical queued data exceeds the configured budget, the runtime closes the connection and the browser reconstructs state through a new handshake.

Harness capabilities differ. `server.welcome.capabilities` initially advertises values such as `abort` and `input.image`; later slices can add `steer` and `follow_up` behind new capability values without a wire-version change. Unsupported actions are rejected explicitly.

`input.image` is implemented end to end (2026-08-01): the browser composer accepts pasted images and sends them as `image` input blocks, the runtime forwards them to Pi's `sendUserMessage` as native image content (`mediaType` → Pi's `mimeType`), and they replicate losslessly through the ordinary history path like any other Pi-persisted content. To accommodate base64 payloads, the runtime's limits are 8 MiB per incoming frame and 6 MiB per prompt (`server.welcome.limits` remains authoritative for clients; the browser enforces the limit at paste time).

## Multiple connections

Naturally support multiple simultaneous WebSocket connections to one orb. Each connection performs its own cursor-based synchronization and has its own bounded outbound writer. Complete history, runtime events, and status are broadcast; `request.result` is sent only to the requester.

All mutating requests from all connections pass through one runtime serial executor. `expectedHeadId`, operation IDs, and request IDs make races explicit: for example, two new-message requests against the same head cannot both succeed. This is not a commitment to multiplayer product features—there is no presence, attribution, shared editor state, or per-user permission model—but browser reloads and multiple tabs do not evict each other.

If a later deployment needs a single-connection policy, enforce it in the runtime rather than the control plane: atomically replace the active connection on a successful new hello and close the previous socket with a private replacement close code. Runtime enforcement works even with multiple control-plane instances. The first slice does not impose this restriction.
