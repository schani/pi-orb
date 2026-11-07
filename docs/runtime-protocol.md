# Runtime protocol

The browser↔agent live WebSocket and the guest runtime's HTTP contract. Schemas: `packages/protocol/src/frames.ts`, `packages/protocol/src/runtime-http.ts`, `packages/protocol/src/display.ts`.

The protocol is harness-agnostic. The Claude guest runtime (`apps/orb-runtime`) serves it over HTTP/WebSocket. Central Pi implements the same browser contract in the control plane (`apps/control-plane/src/http/central-live.ts`): it handles hello/synchronization locally and dispatches requests through the agent facade, without a guest socket. Pi specifics: `docs/pi.md`; Claude specifics: `docs/claude.md`.

User messages do not travel on this socket; they enter the durable inbox (`docs/inbox.md`). History persistence never reads these frames (`docs/history.md`).

## Live transport

The browser opens `/api/v1/orbs/{orbId}/live` with subprotocol `pi-orb.runtime.v1`. The upgrade is authenticated by the browser session (`docs/auth.md`); session expiry closes the socket with `1008`.

- **Claude:** attachment requires running compute. The control plane resolves the orb, opens the runtime's `/v1/live`, and forwards text frames and close/backpressure signals without parsing runtime→browser frames. The proxy installs browser handlers synchronously, before awaiting orb lookup, queues text frames during routing and flushes them in order once the runtime socket opens. It never injects its own data frames, so `client.hello` is the first application frame. Runtime endpoints are reachable only from the control plane's private network.
- **Central Pi:** attaches to the in-process agent plane, read-only while stopped or before execution readiness. Stopped/sleeping views do not resume retained work.

The proxy interprets browser→runtime frames only for idle auto-stop (`docs/lifecycle.md`): it consumes `client.presence` (the runtime ignores one defensively), and a `client.request` refreshes the advisory `last_busy_at` before being forwarded unchanged.

A connection race or unavailable runtime closes with `1013 Try Again Later`; the browser reconnects. Binary frames close the socket with `1003`.

**Close forwarding.** The live and terminal proxies forward only ws-compatible wire codes: 1000–1014 except 1004/1005/1006, and 3000–4999. Anything else, including status-less 1005 and abnormal 1006, closes the browser with 1013. If forwarding throws, the browser transport is terminated. Normalization and termination log a `logOrbEvent` edge with orb, connection, path and original/forwarded codes, never peer reason or exception text; valid closes are quiet.

**Liveness.** No application ping frame. The proxy sends WebSocket protocol pings on both legs (browser↔proxy, proxy↔runtime) every 15 seconds; a leg that misses one probe before the next is terminated, which triggers the browser's cursor-based reconnect. Browsers answer protocol pings without background-tab timers. Timeouts log one edge naming orb, connection and leg; healthy connections log nothing. Rule: a half-open socket must be detected and reconnected, not caught up through a second path.

**Browser connectivity.** `offline` revokes the current socket's authority, closes it and suspends retries until `online`. `online` replaces any socket and reconnects from the latest applied cursor, even without a prior close callback. Retired socket callbacks cannot send hello, publish frames or schedule retries. The browser diagnostic ring records content-free `browser_offline`/`browser_online`. Proxy pings still cover the case where no connectivity event fires. HTTP inbox polling is not transcript polling: it cannot detect a missing assistant suffix. Postmortem: `docs/postmortems/2026-10-05-offline-online-transcript.md`.

The interactive terminal is a separate socket (`/api/v1/orbs/{orbId}/terminal`, subprotocol `pi-orb.terminal.v1`), outside this frame union: `docs/terminal.md`.

## Handshake and synchronization

Every frame has `v: 1` and a discriminating `type`. The subprotocol negotiates the major version; the per-frame version keeps captured frames self-describing.

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
  limits: { maxIncomingFrameBytes: number; maxPromptBytes: number };
}
```

Requests before `client.hello` are rejected. Harness events and socket handlers share one event loop, and the hello handler prepares synchronization synchronously, without `await`:

1. Read the harness snapshot: complete public records and normalized live state.
2. Compute the history boundary and all replay/reconstruction frames.
3. Enqueue `server.welcome`, `sync.started {mode: "full" | "after", afterRecordId}`, `history.record` frames, reconstructing `runtime.event` frames, and `sync.completed {headId}` on the connection's ordered writer.
4. Return; later harness events append after `sync.completed`.

Run-to-completion semantics prevent interleaving, so there is no catch-up queue, barrier or event watermark.

An unknown `afterRecordId` selects `mode: "full"` and replays all complete records; the browser upserts by ID. There is no snapshot payload: the current operation is reconstructed with the same events used live, using `replace` patches for accumulated state. `sync.started` tells the browser to clear transient state. The resume cursor is a durable record ID; no token-delta log is retained.

The synchronization batch is exempt from the outbound budget: it references records already in memory, and closing on its size would recreate the same batch on every retry. Post-synchronization frames that overflow the budget close the connection as usual. Because `afterRecordId` advances with every applied record, a partially delivered synchronization still shrinks the next replay, so reconnect loops terminate. Cost: up to one serialized copy of replayed history buffered per slow client.

A welcome with a different `sessionId` invalidates cached records; a changed `runtimeInstanceId` with the same session does not. Browser cache rules: `docs/history.md`.

## Frames

```ts
type ClientFrame = ClientHello | ClientRequest | ClientPresence;

interface ClientPresence {
  v: 1;
  type: "client.presence";
  visible: boolean; // consumed by the control-plane proxy
}

type MessageInputBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }; // capability `input.image`; base64 without data-URL prefix

type ClientAction =
  | { type: "compact"; customInstructions?: string }
  | { type: "set_model"; model: { provider: string; id: string } }
  | { type: "set_thinking"; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
  | { type: "message"; expectedHeadId: string | null; content: MessageInputBlock[] }
  | { type: "abort"; operationId: string };

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

The live `message` action exists in the schema and request gate, guarded by `expectedHeadId` so a stale tab cannot start a turn against a different head; the browser never sends it and uses the inbox (`docs/inbox.md`). `abort` names an operation ID so a delayed abort cannot hit a later operation; `inbox:<UUID>` targets a queued inbox message (`docs/inbox.md`).

An **operation** is one continuous busy period from an accepted input until the agent returns to idle. It spans root turns, steering, child/shell work, cleanup and committed history publication. Input during a child-only interval runs a root turn inside the existing operation; input during whole-operation cancellation waits for the next one.

Each request gets exactly one requester-only result:

```ts
interface RequestResultFrame {
  v: 1;
  type: "request.result";
  at: string;
  requestId: string;
  result:
    | { type: "settings_applied"; duplicate: boolean }
    | { type: "accepted"; operationId: string; duplicate: boolean }
    | {
        type: "rejected";
        error: {
          code: "invalid_request" | "unsupported" | "busy" | "stale_head" | "stale_operation" | "request_id_conflict" | "internal";
          message: string;
          retryable: boolean;
        };
      };
}
```

Acceptance is not completion. `settings_applied` means applied and persisted; it starts no operation. The ordered `agent_settings` event is authoritative, and a replayed receipt must not update settings. Settings semantics: `docs/agent-context.md`.

State changes are broadcast to every connection:

```ts
interface RuntimeEventFrame {
  v: 1;
  type: "runtime.event";
  at: string;
  event:
    | AgentSettingsEvent
    | RuntimeStatusEvent // {activity: "idle"|"busy", operationId?, work?: "compaction", compactionAfterId?: string|null}
    | OperationStartedEvent // {operationId}
    | OutputPatchEvent
    | ToolStateEvent
    | SubagentsEvent
    | OperationFinishedEvent // {operationId, outcome: "completed"|"aborted"|"failed", message?}
    | TurnNotificationEvent; // {operationId, summary} — 1..240 chars
}

interface OutputPatchEvent {
  type: "output_patch";
  operationId: string;
  blockId: string;
  blockType: "text" | "reasoning";
  revision: number;
  headline?: string; // reasoning only; complete current capped headline
  patch: { type: "append"; text: string } | { type: "replace"; text: string };
}

interface ToolStateEvent {
  type: "tool_state";
  operationId: string;
  callId: string;
  name: string;
  code?: string; // bounded command/code text, root calls only
  revision: number;
  state: "running" | "completed" | "failed";
  message?: string;
  data?: JsonValue;
}

interface SubagentsEvent {
  type: "subagents";
  operationId: string;
  children: Array<{
    id: string;
    description: string;
    taskRecordId?: string; // headline source; detailKey `${taskRecordId}:task`
    kind?: "shell"; // absent means subagent
    phase: "queued" | "running" | "finishing";
  }>;
}

interface HistoryRecordFrame {
  v: 1;
  type: "history.record";
  at: string;
  record: DisplayRecord; // docs/history.md
  headId: string | null;
  retiredBlockIds: string[];
  detailAliases?: Array<{ blockId: string; detailKey: string }>;
}
```

All schemas are closed TypeBox schemas. v1 browsers ignore well-formed unknown server events.

### Completion ordering

`history.record` carries complete display projections during synchronization and live operation. A successful `operation_finished` is sent only after every complete record caused by the operation, including child outcomes, has been emitted. Retirement waits for owned work, cleanup and committed publication; transient retry errors do not override the final outcome.

`turn_notification` is a live-only Luna summary, started only after `operation_finished` and idle status are broadcast, so it never delays completion and failure is only logged. It is not history, not replayed, and lost when no browser is connected.

### Atomic output handoff

Assistant block IDs encode operation ID, message sequence and content index. `retiredBlockIds` names exactly the live blocks a committed record replaces (`[]` during synchronization and for unrelated records). The runtime removes them from reconnect state before broadcasting the frame; the browser adds the record and deletes those blocks in one reducer update, so no render shows both. No text matching, grace period or presentation buffer; a later response may repeat the same text. Rejected: a separate `output_retired` event, which left a two-frame duplicate-render window. Postmortems: `docs/postmortems/2026-09-09-stale-thinking.md`, `docs/postmortems/2026-09-12-mcp-completion-selector.md`.

`detailAliases` maps each retired live reasoning `blockId` to its committed `detailKey`, so an open disclosure stays open across the handoff. They come from the exact native-object/UUID-owned retirement group, filtered to reasoning retained in the display projection; omitted when empty, during synchronization and for unrelated records. The browser inserts `detailKey → blockId` directly, without ordinal pairing or index parsing. When source/canonical correspondence is uncertain, unsafe aliases are omitted.

Snapshot reads flush pending publication before pairing complete history with live state. An open socket exclusively owns history ordering; browser HTTP replica repair applies only while disconnected and clears stale transient output, so a stale HTTP response cannot overtake an atomic socket commit.

### Live reasoning and tools

Live reasoning carries headlines, not bodies. Empty/whitespace nonredacted reasoning is suppressed at live send and replay. The first readable or redacted state emits a content-free `replace` patch with the complete capped `headline` (possibly empty); later patches are sent only when the headline changes. Bodies are read through live detail HTTP. A previously visible block that becomes empty gets no patch and stays until atomic commit; replay omits it while empty. Visible prose patches are unchanged. Postmortem: `docs/postmortems/2026-10-06-empty-live-thinking.md`.

Live `tool_state` joins the tool's canonical card by `callId`, even after the assistant tool-call record persists. Readiness, failure, cancellation and terminal result clear stale waiting metadata; only the current operation contributes live state. Central invocation progress has one publisher, merging execution-wait and nested code-mode progress so neither erases the other. Root `tool_state` carries the same bounded `code` as committed calls (`docs/activity-headlines.md`) and keeps it through completion and replay; private child calls are excluded.

### Subagent roster

`subagents` replaces the operation's complete displayable child/shell roster. Synchronization sends it after operation/tool reconstruction and before status; admissions, starts, cancellation and releases publish changes. Empty means no displayable child work, not idle. Queued admissions and cancelling/finishing holds stay present until release. The browser ignores mismatched-operation rosters and clears them on disconnect, every welcome, synchronization reset and operation change. Roster entries are display data, not drain authority, and carry no prompts, instructions or child transcripts.

`taskRecordId` appears only when no nonblank description was supplied; it names a committed root task-metadata record, committed atomically with the child, and its headline uses the root headline route (`docs/activity-headlines.md`). Harness classification of shells versus subagents: `docs/claude.md`, `docs/pi.md`.

## Manual compaction

`compact {customInstructions?}` is a synchronized live command, not an inbox message, with one admission/completion interface for both harnesses. Harness behavior: `docs/pi.md` (unsupported), `docs/claude.md`.

- It rejects `busy` while root work, children, settings, native pending input or stop preparation holds admission; it never aborts or queues.
- Acceptance returns `accepted {operationId, duplicate}`. Identical request IDs replay acceptance without recompacting.
- The operation holds aggregate busy until compaction, Abort and history publication settle. Status carries `work: "compaction"` and `compactionAfterId`, the last published record at admission (null for an empty transcript). Snapshot/hello preserve that frontier; the UI attaches the first canonical compaction/outcome after it.
- Abort targets this operation; acceptance does not mean cancellation drained. Settings, inbox, live message, child and idle-stop admission stay fenced.
- Success is canonical native compaction history, then `operation_finished`. Failure/cancellation appends a non-model-context `agent.compaction` event with `compaction {operationId, outcome: "failed" | "aborted", message}`, then `operation_finished`. Uncertain persistence fails readiness and keeps ownership.
- No synthetic summary record, Luna summary, control-plane command or queue.

## Ordering, request identity and backpressure

Frames carry no sequence number; per-connection WebSocket ordering suffices. `client.hello` is non-mutating; every request action mutates. All mutating requests from all connections pass through one synchronous request gate.

Request identity is in-memory per runtime process. The registry maps request ID to action and outcome, plus in-flight entries for async settings. Identical in-flight retries join the original result; identical retries of finished requests return the original result with `duplicate: true`; a known ID with a different action returns `request_id_conflict`; an abort naming a finished or unknown operation returns `stale_operation`. A restart empties the registry; `runtimeInstanceId` tells the browser. The browser automatically resends an unacknowledged request only to the same instance; otherwise it synchronizes actual state. Live requests have no durable inbox; durable inbox identity owns message retries. Rejected: a generic hidden `pi-orb.request` marker record, which doubled every mutation.

Outbound writer: 8 MiB critical budget, 512 KiB high-water mark. Under pressure, `output_patch`, `tool_state` and `status` may be coalesced to their newest state **only within the trailing transient segment**; every critical frame (welcome, sync boundaries, request results, history records, operation transitions, errors) fences the backward scan and is never dropped. Coalescing across a critical frame reorders state relative to it (finish A could follow compaction status of B). If critical data exceeds the budget, the connection closes and the browser resynchronizes.

**Invalid frames.** Malformed JSON or schema-invalid text yields a rejected `request.result` (`invalid_request`) when the value is a non-null object with a string `requestId`, otherwise `server.error {code: "invalid_frame"}`. The connection and registry stay healthy; frame content is never logged.

**Capabilities.** `server.welcome.capabilities` advertises `abort` and `input.image`; unsupported actions are rejected explicitly. Limits: 8 MiB per incoming frame, 6 MiB per prompt; `server.welcome.limits` is authoritative and the browser enforces it at paste time. Image blocks are admitted natively and retained in committed history.

## Multiple connections

Any number of connections per orb. Each synchronizes from its own cursor and has its own bounded writer. History, events and status are broadcast; `request.result` goes only to the requester. `expectedHeadId`, operation IDs and request IDs make races explicit. This is not a multiplayer feature: tabs and reloads simply do not evict each other. A single-connection policy, if ever needed, belongs in the runtime (replace on hello, private close code), not the control plane.

## Lazy detail HTTP

`history.record` and browser history carry `DisplayRecord` with `detailKey`s instead of bodies (`docs/history.md`). The runtime serves bodies on demand, under the same bearer/incarnation admission as other routes:

- `GET /v1/details/:recordId/:detailKey?sessionId=<expected>` → `{v:1,sessionId,recordId,detailKey,state:"committed",body}`. The body union covers reasoning text, tool-call arguments, tool-result content, top-level image, compaction text and subagent fields; image leaves carry only an HTTP(S) URL and/or `imageRef`, never base64.
- `GET /v1/images/:recordId/:detailKey/:imageIndex?sessionId=<expected>` → image bytes with a safe Content-Type.
- `GET /v1/details/live/:operationId/:blockId` → `{v:1,sessionId,operationId,blockId,state:"running"|"completed"|"unavailable",body?}` for current reasoning or tool-result progress, including redacted metadata. The runtime retains full active text for coherent snapshots.

Session mismatch is `409` before any read; missing keys `404`; unavailable history `503`. The browser polls live detail roughly once per second while a disclosure is open; there are no subscriptions or revision tokens, and no guaranteed gapless transition to committed detail.

## Runtime HTTP surface

Routes the guest runtime serves (`apps/orb-runtime/src/http/server.ts`). Control-plane `/runtime/v1/*` routes the runtime calls are in `docs/control-plane-api.md`.

| Route | Owner |
| --- | --- |
| `GET /v1/health` | below |
| `GET /v1/history?after=&limit=` | `docs/history.md` |
| `PUT /v1/messages/:messageId` | `docs/inbox.md` |
| `POST /v1/prepare-idle-stop` | below; `docs/lifecycle.md` |
| `GET /v1/details/…`, `GET /v1/images/…` | above |
| `GET /v1/live` (WebSocket) | above |
| `POST /v1/alert` | `docs/orb-alerts.md` |
| `/v1/preview/:port`, `GET/HEAD /v1/files` | `docs/http-exposure.md` |
| `/v1/terminal` (WebSocket) | `docs/terminal.md` |
| `/v1/uploads/:id/:action` | `docs/workspace-uploads.md` |

Typed errors use one shape:

```ts
interface RuntimeHttpError {
  v: 1;
  error: {
    code: "invalid_request" | "cursor_not_found" | "history_unavailable" | "message_unavailable" | "alert_unavailable" | "idle_stop_unavailable";
    message: string;
    retryable: boolean;
  };
}
```

### Health

`GET /v1/health` starts before slow initialization and returns one of:

- `initializing {orbId, runtimeInstanceId, phase, hooks?}` with `phase` one of `booting`, `cloning`, `setup_running`, `checking_project_secrets`, `loading_session`, `checking_auth`. `setup_running` holds the boot deadline (`docs/orb-setup-hook.md`).
- `ready {orbId, runtimeInstanceId, sessionId, checkoutCommit (null without commits), activity, operationId?, executionId?, incarnation?, turnResume?, streams?, streamTelemetryError?, hooks?}`. `executionId` and `incarnation` feed preview admission (`docs/http-exposure.md`). `turnResume {outcome, shape?, headRecordId?}` reports a notable boot decision only: `resumed`, `notified_restart`, `declined_already_resumed`, `resume_failed` (`docs/lifecycle.md`). A boot-triggered turn owns the ordinary busy operation before readiness admits other input; the notice itself is a durable history record, not a new frame.
- `failed {orbId, runtimeInstanceId, error {code, message, retryable, diagnostics?}, recovery?}`. `diagnostics` is a sanitized string of at most 16,384 characters (Claude initialization/stream failures: `docs/claude.md`); `message` carries the user-facing stage/cause. The control plane records both on the terminal-failure lifecycle edge; `last_error` keeps the summary. `recovery {episode}` accompanies `error.code: "claude_child_recovery_required"`; its role in compute replacement: `docs/lifecycle.md`.

`hooks` reports the latest `setup`/`resume` hook outcomes (`docs/orb-setup-hook.md`).

### Execution HTTP

Central Pi's execution host serves workspace operations to the control plane (`apps/orb-runtime/src/execution/server.ts`, paths in `packages/protocol/src/execution.ts`): `/execution/rpc`, `/execution/exec`, `/execution/cancel`, `/execution/ready`. Every route requires the runtime bearer and the exact `x-orb-incarnation` header (stale incarnation `409`) and answers `503` until ready; `/execution/ready` then returns cwd, incarnation, PID, checkout commit and optional hook reports, or the failed/initializing health. Requests and whole-file reads are capped at 16 MiB. Binary readers are host-side handles paged in 1 MiB responses (`read`, `info`, `scanLines` run on the host; `read` never transfers a whole file); directory readers page one `listDir`; `watch` returns `not_supported`. Argv `exec` and per-chunk stream names cross the wire; `ShellExecOptions.window` is not forwarded, so every chunk is delivered. No inference, model auth, MCP or repository extension loading runs there. Caller semantics: `docs/pi.md`.

### Idle-stop preparation

`POST /v1/prepare-idle-stop` with `{v:1}` returns `{v:1,prepared:false}` while owned work remains, or `{v:1,prepared:true}` after atomically closing first-party message/inbox/subagent admission before the final history drain. SDK-originated root starts are aborted before inference. Calls are idempotent; errors and lost answers never grant permission to stop. History and health stay readable. The fence persists in a private `<workDir>/.idle-stop-fence` lifetime record (atomic replace behind a Result port) so a runtime-only restart keeps it; a new host lifetime reopens admission. Uncertain fence persistence fails readiness and stays closed. Control-plane use (idle stop, archival): `docs/lifecycle.md`. Postmortem: `docs/postmortems/2026-09-14-idle-stop-admission-race.md`.

## Runtime client

The control plane reaches the runtime through a Result-based port (`apps/control-plane/src/domain/ports.ts`):

```ts
interface OrbRuntimeClient {
  health(task, baseUrl, context): ResultAsync<RuntimeHealth, RuntimeClientError>;
  pullHistory(task, { baseUrl, after, limit }, context): ResultAsync<PullHistoryResponse, RuntimeClientError>;
  deliverMessage(task, request, context): ResultAsync<DeliverOrbMessageResponse, RuntimeClientError>;
  prepareIdleStop(task, baseUrl, context): ResultAsync<PrepareIdleStopResponse, RuntimeClientError>;
  readDisplayDetail(task, baseUrl, sessionId, recordId, detailKey, context): ResultAsync<CommittedDisplayDetail, RuntimeClientError>;
  readLiveDisplayDetail(task, baseUrl, operationId, blockId, context): ResultAsync<LiveDisplayDetail, RuntimeClientError>;
  readDisplayImage(task, baseUrl, sessionId, recordId, detailKey, imageIndex, context): ResultAsync<{ mediaType: string; data: Buffer }, RuntimeClientError>;
}
```

Every call passes its signal to `fetch` (or the simulated transport), so a hung request cannot pin a reconciler. Cancelling a delivery only cancels the caller's wait; it does not retract a request the runtime may have accepted.

`RuntimeClientError` carries `answered` (whether an HTTP response arrived) and `retryable`. Body transport is classified separately from JSON/schema validation: interrupted reads after headers are typed, retryable and unanswered, with phase/status/cause diagnostics. Only a complete successful response with invalid JSON/schema is `invalid_response`. Malformed non-success bodies are status-based `http_error`; parsed typed errors keep their classification. Parse diagnostics are fixed strings, never body or parser text. This keeps interruption from being treated as a history-integrity failure (`docs/history.md`).

This is a direct breaking contract between control plane and runtime: running orbs on an older contract are stopped and restarted.
