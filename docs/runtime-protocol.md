# Harness-agnostic orb runtime protocol

The runtime protocol describes agent-runtime behavior rather than Pi behavior. Runtime HTTP depends on the Result-based `OrbAgent` port, implemented by Pi and the local Claude POC.

**Claude POC boundary (2026-10-04; not deployed).** Native queries rotate after a completed root and no independently held subagent admissions, task edges, background-task inventory, or hooks. Root `result` alone never grants idle. The initial account/catalog probe and every rotation wait for supervised subprocess exit, SDK iterator/stdout completion, MCP request cleanup, and fsynced/published native history. This reruns native SessionStart/SessionEnd hooks; it is not always-open-query parity or proof of native pre-inference admission fencing. Late native inference during rotation is a failed operation, not an invented completed turn. Native background terminal notifications retain a finishing handoff hold until a subsequent root result; a silent native handoff remains busy, rather than being closed prematurely. Known interrupted input gets a durable notice and permits manual next-message continuation without replay; missing input receipts or unreconciled child ownership fails visibly. Automatic native interrupted-turn inference and an unconditional pre-inference continuation fence remain unqualified. Unexpected SDK EOF is a visible failure, not a ready dead query. Busy inbox deliveries remain in the control-plane durable inbox; no Pi-style steering. The shared composer sends messages and settings; terminal/uploads remain available normally. Credential source validation precedes prompt admission, and each reopened query fetches the current owner grant. See `docs/claude-agent-sdk.md`, `docs/credentials.md`, and `docs/history-replication.md`.

## Central process transport (2026-10-03)

The central backend shares the browser display-frame schema and settings/history handshake. Canonical full transcript records remain in the separate PostgreSQL replica; live/replayed browser records use the same ancestry-aware lazy display projection as host-Pi. Reasoning patches carry bounded headlines, while full live reasoning is read through the central agent facade and committed details/images through the replica. Detail reads never construct a Harness or wake execution. Its authenticated live route attaches directly to the central agent plane; agent history and commands do not proxy through the guest. Live attachment and durable message input do not depend on VM readiness. Explicitly stopped/sleeping views attach read-only without resuming retained work; fresh authorized HTTP inbox input can supersede inhibition. Execution HTTP is a separate authenticated, incarnation-fenced boundary for workspace tools and guest services. Immediate lazy facades wait only when a VM method is invoked, pin one guest per tool invocation, and release leases on cleanup. Tool progress shows a bounded execution-wait reason, cleared when readiness or a terminal outcome arrives; sanitized lifecycle outcomes correlate task/call IDs. The independently selected `host-pi` backend retains the runtime-owned protocol below. Tool transport errors are typed; unsafe shell/codemode interruption is not automatically replayed.

**Candidate stable handle (2026-10-04; unqualified):** subscriptions bind to a metadata-only per-orb handle, not a replaceable Harness; unload/reopen preserves listeners while generation checks discard stale owner publications. Requests retain current admission/owner fences and never retarget already-bound effects. Passive hello reads PostgreSQL without opening the Harness. Before the first public header it returns empty `conversation:<orbId>` history, matching the eventual new native identity; this permits attachment and pending Abort before Git completes. Earlier 2026-10-03 qualification used owner-invalidating `1012` reconnect; its streaming regression evidence in `docs/testing.md` does not qualify this candidate.

**Initial checkout (candidate, 2026-10-04):** `GET /api/runtime/initial-checkout` requires bearer authentication and exact `x-orb-incarnation`. Responses: `200 {commitSha}`, `202 {pending:true}`, `409 {error:checkout_admission_revoked}`, or `503 {error:resource_acquisition_failed|unavailable}`. Acquisition failure is terminal; unavailable is retryable. Fresh checkout polls within the existing 20-minute deadline/cancellation bound. An initial `401` may precede provider bearer CAS attachment and is retryable only until the first authenticated response; after authenticated `202`, later `401` is terminal. `403` and `409` are always fatal. Retained workspaces bypass this endpoint. Central production provisioning always sets the stable `awaitInitialCheckoutCommit` bootstrap flag, even when a SHA is already known; host Pi provisioning does not. Allocation and resource fetching are concurrent; pending acquisition does not churn the host fingerprint.

**Pending Abort (implemented candidate, not fully qualified):** cancellation uses durable `inbox:<UUID>` identity and runs outside the resource-loading admission queue without loading a Harness. The orb-locked transaction checks actual native submission and batch membership: native admission winning before the app ACK delegates to active abort rather than failing admitted input. Cancellation winning prevents native admission atomically. Cancelled frozen-batch members detach surviving unadmitted rows for a new membership-derived batch; late old-batch failure cannot fail reclaimed survivors. Abort accepts only matching queued/placed native input, never a historical receipt for an unrelated later turn. A queued native abort without public representation records app failure `Cancelled after agent admission`; publicly delivered entries remain unchanged. An active request with no loaded engine reports retryable `history_unavailable`, not success. Remaining acceptance is tracked only in `TODO.md`.

A conceptual in-process client boundary is Result-based:

```ts
interface OrbRuntimeClient {
  health(context: OperationContext): ResultAsync<RuntimeHealth, RuntimeClientError>;
  prepareIdleStop(context: OperationContext): ResultAsync<PrepareIdleStopResponse, RuntimeClientError>;
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

**Codex failure context (implemented locally 2026-09-26; deployed later that day from `3c5e7bc`, release evidence: `docs/deployment.md`).** A failed `openai-codex` assistant `MessageRecord` with a nonblank `errorMessage` may include `failure.context`, an optional closed, typed object replicated through ordinary history; no new runtime frame or UI suffix. The Pi adapter projects the last `codex_failure` diagnostic into this object, omitting absent or invalid facts. Allowed fields: `brokerGeneration` (nonnegative safe integer), `tokenExpiresAt` (epoch milliseconds, integer 0–8,640,000,000,000,000), `transport` (`sse` | `websocket`), `phase` (`before_message_stream_start` | `after_message_stream_start`), `attempt` (integer 1–20), HTTP `status` (100–599), WebSocket `wsCloseCode` (1000–4999), `code` (only `invalid_api_key`, `invalid_grant`, `unauthorized`, `authentication_error`, `invalid_token`, `rate_limit_exceeded`, `usage_limit_reached`, `insufficient_quota`, `websocket_connection_limit_reached`, `previous_response_not_found`), and `requestId` (`req_` plus 8–64 ASCII alphanumerics, or canonical lowercase UUID). `status`/`code`/`requestId` appear only when structured data supplies them; raw provider text, headers, tokens, fingerprints and WebSocket reason are not new fields. The existing `failure.message`/diagnostic types, Pi `errorMessage`, and SDK retry behavior are unchanged. Preexisting native diagnostic payloads remain lossless; new Codex facts in native overflow are allowlisted, including an earlier WebSocket fallback leg. The mapped context describes only the last Codex failure. See `docs/credentials.md` and `docs/pi-adapter.md`.

**Idle-stop/archive admission barrier (decided 2026-09-14).** After durably entering `stopping` for idle auto-stop, the control plane sends `POST /v1/prepare-idle-stop` with JSON `{v:1}`. `{v:1,prepared:false}` means owned work remains: return to `running` with reason `idle_stop_declined_busy`. `{v:1,prepared:true}` atomically closes first-party message/inbox/subagent admission before the final history drain. SDK-originated root starts are aborted before inference. Repeated calls are idempotent; errors and lost answers never grant permission to stop. History/health reads remain available. A private `<workDir>/.idle-stop-fence` lifetime record, atomically replaced behind a Result-based persistence port, preserves the fence across runtime-only restart even when Pi has not yet flushed its first session. It is scoped to host execution (or managed supervisor lifetime for the unsandboxed process provider), without claiming detached processes died. A `pi-orb.idle-stop-prepared` root fact supplies normal history visibility; the control-plane drain edge also records `idle_stop_prepared:true`. A new host lifetime reopens admission. Uncertain fence persistence fails readiness and stays closed; prepare failures are edge-logged and exposed as drain errors. Archival uses the same endpoint before its final drain/seal; a busy decline leaves archival pending and does not stop its ongoing history pulls. Sealing must still target the prepared compute. Explicit Stop does not require this idle/cooperation precondition. The field contract is defined by `PrepareIdleStopRequestSchema` / `PrepareIdleStopResponseSchema` in `packages/protocol/src/runtime-http.ts`. Rationale and first replay: `docs/postmortems/2026-09-14-idle-stop-admission-race.md`.

**Boot notifications (2026-09-05).** Ready health's optional `turnResume.outcome` now also accepts `notified_restart`, alongside `resumed`, `declined_already_resumed`, and `resume_failed`. It identifies an immediately triggered between-turn restart-context turn, not human input. The notice/decline/failure itself is a durable history record and uses the existing live publication/replication paths; no new request or event frame is introduced. A boot-triggered turn owns the ordinary busy operation and turn-start barrier before readiness can admit competing input. Runtime-local decisions and accurate host-versus-runtime wording: `docs/lifecycle.md`; complete health example: `docs/host-provider.md`.

**Scheduled sleep extension (decided 2026-09-17; implementation in progress).** Optional validated system provenance makes sleep notices singleton FIFO items rather than human batches. Event records may carry `inboxMessageIds`, so ordinary replication acknowledges them. Before attachment/readiness/inference, `POST /runtime/v1/orb/boot-context` may return only a FIFO-head `sleep_wake`; it never skips an older human item or acknowledges delivery. A prerequisite-read failure fails closed. The runtime persists one combined restart/sleep record before inference and deduplicates crashes from local identity; this promises neither exactly-once inference nor model effects. Exact schemas, guard semantics, and DST matrix: `docs/orb-sleep.md`.

**MCP boot configuration (2026-09-08).** `GET /runtime/v1/mcp` is a control-plane route authenticated with the existing incarnation bearer. It returns that orb's project catalog `{revision, servers}` containing secret references, not resolved keys. The runtime resolves them against its project-secret boot snapshot and adopts changes on next process start. OAuth entries (2026-09-10) additionally carry `oauth: {id}`; `POST /runtime/v1/mcp/:id/token` accepts `{url, rejectedGeneration?}` and returns `{accessToken, expiresAt, generation}` after deriving project authority from the caller and validating current ID/URL ownership. Only access tokens enter runtime memory; request-time resolution refreshes an existing connection without changing the boot catalog. Native Pi has only a tokenless auth hook for bounded 401/challenged-403 retries; the control plane alone owns consent and refresh tokens. Its invalid-session 404 may also retry once. Unknown accepted writes whose responses are lost are not replayed. This adds no WebSocket frames or first-message gate. Native MCP tool output, configuration adoption and sanitized `pi-orb:mcp-status` custom-entry edges use normal session history and replication (`docs/mcp.md`).

## Local alerts (2026-09-30)

`POST /v1/alert` accepts `{v:1,message,requestId}` under the runtime's incarnation bearer and returns `{v:1,id,duplicate}` only after persistence. The CLI calls this endpoint locally; the browser does not. An alert is a non-model-context history event, not a new agent command or inference turn. SDK guests persist locally and use committed-history notifications and pull replication. The central process POC's execution guest forwards to `POST /api/runtime/alert` with bearer authentication and exact `x-orb-incarnation`; the application alert writer fences identity, appends native durable history and deduplicates before replying. Neither path introduces model input or a new WebSocket frame. `docs/orb-alerts.md` owns admission, retry identity, acknowledgement, and testing.

## Agent settings (implemented locally 2026-09-14)

`docs/agent-settings.md` defines `set_model` / `set_thinking`, a complete `agent_settings` synchronization/live event, an operation-free `settings_applied {duplicate}` receipt, and idle-only shared agent admission covering HTTP inbox delivery as well as WebSockets. Explicit assignments are last-applied-wins, without head/revision CAS. The existing request registry now holds in-flight async settings results as well as completed outcomes: identical retries join/replay, conflicts reject. A 15-second deadline fails readiness without releasing unsafe input admission; late SDK completion cannot restore it. Known pre-mutation auth failures release admission and report rejection. Native session settings remain persistent authority; no control-plane settings API, queue or table is added. The frontend clears availability on disconnect and obtains the complete pair/catalog in every hello batch, including a caught-up cursor. The synchronous WS gate alone is not an async serial executor; `AgentSettingsController` claims configuration before awaiting SDK work.

## Workspace-upload transport (implemented 2026-09-09)

Arbitrary browser files use the separate streaming HTTP path in `docs/workspace-uploads.md`; they do not become image blocks, base64 frames, or live WebSocket commands. Runtime upload actions carry an incarnation header, persist immutable chunks on the workspace, and return only bounded progress metadata. After every file in a picker selection is stored or cancelled, the control plane submits one normal inbox message listing the successful paths, with wake suppressed. The selection's immutable batch identity deduplicates notification across retries and recovery; file completion does not enqueue per-file messages. This reuses ordinary turn/steer delivery and replication rather than introducing context-only harness mutations. Running-only admission and transfer-wide idle protection are lifecycle rules, not agent busy activity.

## Transport and control-plane handoff

The browser opens `/api/orbs/{orbId}/live` only after the normal control-plane HTTP API reports the orb as running. It offers the WebSocket subprotocol `pi-orb.runtime.v1`.

Deployed stages 1–2 authenticate the browser WebSocket request before this handler. Trusted-company direct orb access remains unchanged; runtime authentication is a separate surface. The control plane resolves the orb, opens its runtime WebSocket, then forwards text frames and close/backpressure signals without parsing application frames. Because the browser sends `client.hello` immediately after its upgrade completes, the proxy installs browser message handlers synchronously before awaiting orb lookup or host observation, queues text frames during routing, and flushes them in order once the runtime socket opens. It emits no control-plane data frame into the runtime stream. Runtime endpoints should still remain reachable only from the control plane's local Docker network so the browser topology does not accidentally become a direct-browser/runtime API.

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

**Browser transcript caching (2026-09-15, local implementation):** the browser may obtain `afterRecordId` from its bounded in-memory cache rather than a new database read (`docs/transcript-cache.md`). A welcome naming a different session invalidates the cached namespace and reconnects from null, even if an old record ID happens to exist in that different session. A changed runtime instance with the same session does not invalidate complete records. Full-sync start clears the old cache entry; an interrupted replacement is not cache-admitted until `sync.completed` or a subsequent consistent full HTTP snapshot independently establishes a complete prefix while disconnected. Cached records grant no live readiness, settings or request-replay authority. These are client ownership rules, not additions to the frame schema or runtime replay contract.

There is deliberately no separate snapshot payload. Synchronization expresses the current operation as the same events used for live updates, with `replace` patches where complete accumulated state is needed. This keeps one reducer and one event model. `sync.started` tells the browser to clear transient state before applying the reconstructing events.

This provides reconnect without retaining a token-delta replay log. The resume cursor is a durable history record ID, while replayed ordinary events reconstruct transient work.

## Frame union

Keep the top-level union small. The currently implemented browser protocol sends a hello or a request. Its `message` action is running-runtime-only. The send-anytime design below moves browser user messages out of this live mutation path rather than adding `steer` and `follow_up` wire variants; abort remains a live-only request.

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
  | { type: "set_model"; model: { provider: string; id: string } }
  | { type: "set_thinking"; thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
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

`expectedHeadId` prevents a stale tab from silently starting a turn against a different conversation head. Requiring an operation ID prevents a delayed abort from affecting a later operation. An operation is one continuous busy period from an accepted new message until the runtime returns to idle. Under the send-anytime design, a message delivered while busy steers and joins the active operation; a message delivered while idle starts a new operation.

A request receives exactly one requester-only result:

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

Agent acceptance is not operation completion. Settings success instead means application and persistence completed; it does not start an operation. Its ordered `agent_settings` event (full schema in `docs/agent-settings.md`) is authoritative, whereas a replayed receipt must not update settings. State changes are broadcast to every connected browser as a single event envelope:

```ts
interface RuntimeEventFrame {
  v: 1;
  type: "runtime.event";
  at: string;
  event:
    | AgentSettingsEvent
    | RuntimeStatusEvent
    | OperationStartedEvent
    | OutputPatchEvent
    | ToolStateEvent
    | SubagentsEvent
    | OperationFinishedEvent
    | TurnNotificationEvent;
}

interface OutputPatchEvent {
  type: "output_patch";
  operationId: string;
  blockId: string;
  blockType: "text" | "reasoning";
  revision: number;
  headline?: string; // reasoning only; complete current capped summary, not a text delta
  patch: { type: "append"; text: string } | { type: "replace"; text: string };
}

interface SubagentsEvent {
  type: "subagents";
  operationId: string;
  children: Array<{
    id: string;
    description: string;
    phase: "queued" | "running" | "finishing";
  }>;
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

**Canonical tool activity (2026-10-03).** Live `tool_state` metadata joins the tool's canonical card by call ID even after its assistant tool-call record persists. Persistence must not discard the live waiting reason. Ready, failure, cancellation and terminal result clear obsolete waiting metadata; only the current operation contributes live state. **Correction (2026-10-06):** central invocation progress has one publisher: it merges lazy execution acquisition with nested code-mode details so concurrent nested progress cannot erase a held execution wait. Controlled composed tests acknowledge public waiting before nested progress, Abort or readiness release; browser fixtures use orb/operation/call-scoped phase barriers, not global summary counts.

**Atomic streaming output handoff (decided and implemented 2026-09-12).** Assistant block IDs include an operation ID, message sequence, and content index. Each `history.record` carries required `retiredBlockIds: string[]`; synchronization and unrelated records use `[]`. The runtime removes exactly those blocks from reconnect state before broadcasting this single critical frame. The browser adds the record and deletes those blocks in one reducer update, so no render contains both representations of the same response. No text equality, grace period, or presentation buffer is involved. A later response may legitimately repeat the same text.

```ts
interface HistoryRecordFrame {
  v: 1;
  type: "history.record";
  at: string;
  record: DisplayRecord;
  headId: string | null;
  retiredBlockIds: string[];
}
```

Pi's `message_end` and its persisted entry share the same message object (pinned SDK contract test). The adapter captures only that message sequence's block IDs before Pi appends, associates them by object identity in a weak map, and consumes the association when mapping/publication succeeds. A mapping failure leaves live output intact. Snapshot reads synchronously flush pending publication before pairing complete history with live state. Browser HTTP replica repair applies only while disconnected and clears stale transient output; an open socket exclusively owns history ordering, including patches still in flight. A stale HTTP response must not jump ahead of an atomic socket commit.

**Superseded approach:** the 2026-09-09 separate `output_retired` event fixed permanently stale reasoning but left an observable two-frame duplicate-render window. It is removed, not retained as a compatibility path. Tolerating the overlap in the MCP E2E selector was an insufficient correction and has been reverted. Sixteen explicit deterministic schedules enumerate next-response timing, backpressure, snapshot versus microtask publication, and a mapping failpoint; they inspect every delivered frame and reconnect state. Evidence: `docs/postmortems/2026-09-09-stale-thinking.md`, `docs/postmortems/2026-09-12-mcp-completion-selector.md`.

Complete display projections use `history.record` both during synchronization and live operation. They improve UI responsiveness, but the control plane ignores them for persistence. A successful `operation_finished` event is sent only after all complete history records caused by that operation have been emitted. **Outcome correction (2026-10-06):** host Pi retires only after SDK retry, turn-start, idle, child-drain and history-publication fences. The final persisted assistant added during the operation determines terminal failure; an intermediate retry error does not poison a successful retry or later turn. Abort and rejected-submission failure retain precedence. Installed-SDK SSE contracts cover successful upload continuation, pre-header socket closure, truncated streams, recovered retry and abort; these do not explain the historical missing continuation request.

Agent turns may later emit a live-only `turn_notification { operationId, summary }` runtime event. The Luna summary starts only after `operation_finished` and idle status have been broadcast, so inference never delays completion and failure can only be error-logged. This event is presentation data: it is not a Pi history record, is not replicated or replayed during synchronization, and is simply lost when no browser is connected.

No application-level ping frame is needed. The control-plane proxy probes both legs of every live connection with WebSocket protocol ping/pong; browsers respond to protocol pings in the networking layer without depending on background-tab JavaScript timers. A leg that does not answer one 15-second probe before the next probe is terminated, which drives the browser's ordinary cursor-based reconnect and synchronization. Runtime status/health remains ordinary state, not a ping substitute.

**Field finding and fix (2026-09-01) — half-open background tabs.** The protocol claimed protocol-level dead-peer detection, but neither the runtime nor proxy had implemented a ping loop. A browser/network path could therefore become half-open while a tab was backgrounded: the browser still reported an open WebSocket, no close event started reconnect, and all history committed after the break remained absent until a page reload established a new connection. A deterministic transport reproduction pins the exact failure shape—locally open peer that stops answering pings—and the proxy now monitors both browser↔proxy and proxy↔runtime legs. Timeout logs are edge-only and identify orb, connection, and failed leg; healthy connections log nothing. Reconnecting rather than inventing a second catch-up path is required because the existing `afterRecordId` handshake is already the authoritative recovery mechanism.

**Browser connectivity recovery (implemented locally 2026-10-05, America/Cancun):** an `offline` event immediately revokes the current socket's authority, closes it and cancels retries until `online`. An `online` event replaces any existing socket and reconnects using the latest applied record cursor, even without an earlier offline/close callback. Retired socket callbacks cannot send hello, publish frames/status or schedule retries; disposal removes both connectivity listeners. The bounded browser diagnostic ring records content-free `browser_offline`/`browser_online` reasons. Deterministic tests reproduce an offline→online socket remaining locally open without a close callback; this proves the client recovery gap, not the cause of the reported field incident. Proxy ping/pong detection remains necessary when no browser connectivity event fires. HTTP inbox polling is not transcript polling: empty deltas do not detect a missing assistant suffix, and HTTP history still cannot merge through an open live socket. Report, reproduction and evidence: `docs/postmortems/2026-10-05-offline-online-transcript.md`.

All schemas will be closed TypeBox schemas. An invalid request receives a rejected `request.result` where its request ID can be recovered, otherwise `server.error`. A v1 browser should ignore a well-formed unknown server event so optional capabilities can be added without breaking old clients.

## Lazy transcript detail (decided 2026-10-01; implemented locally, validation pending)

`history.record` and browser HTTP history project each full persisted record into `DisplayRecord` (`packages/protocol/src/display.ts`). The runtime's `GET /v1/history` still returns complete `HistoryRecord` for replication. Browser display records preserve IDs, ancestry, order, cursor and head. Visible prose remains inline; reasoning, tool arguments/results, compaction summary and subagent detail are addressed by `detailKey` (`recordId:blockIndex`, `recordId:summary`, `recordId:subagent`). Each tool call/result survives as its own block; the browser pairs by `callId` within parent ancestry, preserving call order and unmatched result fallback. Empty/whitespace public reasoning blocks are omitted, but their record identity and original detail indices remain; redacted notices and nonempty headingless reasoning survive. Canonical history/detail bodies are unchanged. Reasoning blocks include a `headline`: GFM ATX/setext headings and bold-only single physical lines, flattened and joined in order with ` · `; code and multiline bold are excluded, redacted blocks use an empty headline. The pure protocol parser is shared with live sends and reconnect replay. Reasoning headlines and `read`/`edit`/`write` paths are capped at 1 KiB UTF-8 including the ellipsis; non-generating unknown tools use an empty headline. **Implemented locally (2026-10-04); full qualification in progress, not deployed:** eligible activity calls/results/root receipts use `headline?: string | null`; null requests lazy generation, strings (including empty) do not, and absence offers none. The shared pure source projection emits null without inference or cache reads; existing record/detail/session identity suffices. Result eligibility follows parent ancestry because SDK `getEntries()` includes all branches and sibling calls may reuse IDs. Metadata-only ancestry deltas retain no raw source/private child data, with O(records) storage and O(depth) lookup. Canonical `steer_subagent` calls offer intent from a non-whitespace string `message` and optional string `agent_id` only; acknowledgements, including delivery errors, remain outcome-ineligible and preserve intent. Canonical `get_subagent_result` calls are eligible intents: source text includes only bounded `agent_id` and boolean `wait`/`verbose` arguments, never target-agent transcripts or arbitrary metadata. **Decision (2026-10-05; implemented locally, not deployed):** canonical SDK `bash` calls/results offer intent/outcome headlines; codemode retains intent-only eligibility. Codemode launch acknowledgements have no outcome marker; foreground subagent terminal output and typed root completion receipts retain their existing eligibility. Calls also carry optional `code: string`, selected only from string `args.command` or `args.code` respectively, preserving whitespace/multiline text within 1,024 UTF-8 bytes including ellipsis. Empty/whitespace-only or malformed input omits code and intent eligibility. No aliases, command arrays, auth metadata, native overflow, private child data or detail downloads. The matched call's code is the header fallback for null/absent summaries; strings including empty replace it, and errors override it. Outcome markers retain presence-based precedence; no outcome code field. Live root `tool_state` carries the same bounded optional code before completion, retains it on completion and reconnect replay, and excludes private child calls. Eligibility and result-presence precedence are specified in `docs/activity-headlines.md`; WebSocket transport remains content-agnostic. `targetId` distinguishes clipped paths without exposing full paths. Tool-result image presence and diff counts remain in the summary. Model exposes only optional provider; failure exposes message and `providerTransportFailure` boolean, not raw diagnostics, native overflow, usage or full image data.

Authenticated runtime `GET /v1/details/:recordId/:detailKey?sessionId=<expected>` returns `{v:1,sessionId,recordId,detailKey,state:"committed",body}` and `GET /v1/images/:recordId/:detailKey/:imageIndex?sessionId=<expected>` returns binary image bytes with a safe Content-Type. Session mismatch is rejected with 409 before reading. The detail body union includes reasoning text, tool-call arguments, tool-result content, top-level image, compaction text and subagent fields; image leaves may contain only an HTTP(S) URL and/or `imageRef`, never base64. The binary route handles local image bytes. Missing keys return 404 and unavailable history 503 with typed runtime errors.

`GET /v1/details/live/:operationId/:blockId` returns `{v:1,sessionId,operationId,blockId,state:"running"|"completed"|"unavailable",body?}` for current reasoning or tool-result progress. The runtime retains full active text for coherent snapshots. Reasoning `output_patch` frames carry empty replace text plus the complete current capped `headline` on live send and replay (decided 2026-10-04). Send the initial identity and subsequent headline changes, including an empty headline when titles disappear or become redacted; body-only changes remain HTTP-only. Visible prose patches remain unchanged. Browser disclosures poll live HTTP roughly once per second while open, without subscriptions, revision tokens or a guaranteed gapless transition to committed detail. The WebSocket still carries identity, lifecycle and atomic block retirement; no streamed private reasoning/tool body is required. This is a direct breaking browser/runtime contract: old running orbs are stopped and restarted, with no compatibility path.

## Ordering, request identity, and backpressure

WebSocket ordering is sufficient within one connection, so frames do not have an event sequence number. Synchronous hello preparation creates the synchronization boundary. Reconnection uses complete record IDs and reconstructed live events, not a socket event offset.

`client.hello` is non-mutating: it observes and synchronizes state. All request actions are mutating: `message` starts agent work, and `abort` changes a running operation. HTTP health and history pulls are also non-mutating from the runtime's perspective. Control-plane host start/stop operations are mutations in a different API.

Request identity is in-memory and scoped to one runtime process. The runtime keeps a map from request ID to its action and outcome for the life of the process, plus in-flight entries for async settings mutations. Identical in-flight retries join the original result without another SDK call. Resending a known request ID with an identical action returns the original result with `duplicate: true`; reusing a known ID with a different action returns `request_id_conflict`; an abort naming a finished or unknown operation returns `stale_operation`.

A runtime restart empties that map, and `server.welcome.runtimeInstanceId` tells the browser so. After reconnecting, the browser may automatically resend an unacknowledged request only when `runtimeInstanceId` matches the instance that received it. When the instance has changed, the browser relies on synchronization instead: the Pi adapter uses `AgentSession.sendUserMessage`, and Pi appends an accepted user message to the session on its awaited `message_end`, before model streaming begins, so a delivered message always appears in the replayed history. If it appears, the request was delivered; if it does not, it never reached the model, and the user decides whether to send it again as a new request.

There is deliberately no durable inbox for the currently implemented live-only abort requests. The earlier generic `pi-orb.request` marker proposal remains rejected: it doubled every mutation with a hidden record and was unnecessary for live-only delivery.

The send-anytime inbox changes the premise for **user messages only**. A stopped runtime cannot own a queue, and accepting a message before startup requires durable control-plane state plus restart-stable delivery identity. The design therefore uses one Pi custom-message record as the delivered user message itself—not a marker plus a second record. Its native details carry every control-plane message ID in that delivery batch, it is mapped and rendered as an ordinary user message, and its content is ordinary model context. This gives one durable record per delivered batch and lets a restarted runtime recognize delivery without duplicating it.

Under outbound pressure, transient output and tool-state events may be coalesced to their newest equivalent state. Welcome, synchronization boundaries, request results, complete history records, operation transitions, and errors are never intentionally dropped. If critical queued data exceeds the configured budget, the runtime closes the connection and the browser reconstructs state through a new handshake.

Harness capabilities differ. `server.welcome.capabilities` initially advertises values such as `abort` and `input.image`. In the send-anytime design, steering is an internal delivery choice behind the control-plane message API rather than a browser-selected live capability; a future product that exposes an explicit steer/follow-up choice could still add capabilities without a wire-version change. Unsupported actions are rejected explicitly.

`input.image` is implemented end to end (2026-08-01): the browser composer accepts pasted images and sends them as `image` input blocks, the runtime forwards them to Pi's `sendUserMessage` as native image content (`mediaType` → Pi's `mimeType`), and they replicate losslessly through the ordinary history path like any other Pi-persisted content. To accommodate base64 payloads, the runtime's limits are 8 MiB per incoming frame and 6 MiB per prompt (`server.welcome.limits` remains authoritative for clients; the browser enforces the limit at paste time).

## Send-anytime message inbox (decided and implemented 2026-08-10)

### One ingress path

Every agent **message**, whether the orb is busy, idle, starting, or stopped, should enter through one idempotent control-plane HTTP command. The browser must not choose between “send”, “steer”, and “queue”, and must not race an HTTP offline path against the live WebSocket path. Abort remains live-only because it names a current operation.

The browser generates a message UUID and uses `PUT /api/v1/orbs/{orbId}/messages/{messageId}`. A successful `202` means the message is durably accepted in PostgreSQL, not that Pi has consumed it. Repeating the same ID and identical body returns the same resource; different content conflicts. The live WebSocket remains the ordered history/transient-output channel and no longer carries new message actions once this proposal is implemented.

This is a deliberate narrowing of the content-agnostic proxy, not a second message path: message content terminates at the finite control-plane command endpoint, while the long-lived live proxy still does not inspect runtime→browser agent frames. Stretching `/live` so it remains open while no runtime exists was rejected: the control plane would have to impersonate the runtime handshake, retain frames, switch ownership during startup, and recover socket-local acceptance after process death.

### Durable FIFO and lifecycle wake

The control plane stores a per-orb FIFO inbox row containing the client message ID, validated content blocks, insertion order, status, and a sanitized delivery error. Inbox insertion and any lifecycle wake intent commit atomically. `creating`, `starting`, and `running` need no extra lifecycle transition. A stopped or failed orb enters the ordinary `starting` path — through the reconciler's single message-driven transition rather than through admission itself (`docs/lifecycle.md`, 2026-08-11); a message accepted during `stopping` records a restart-after-stop wake, and the normal stop drain completes before startup. An explicit stop linearized after a message clears that wake and leaves undelivered messages queued; a later message sets it again. Thus an explicit stop is not defeated by an immediate automatic bounce, while a send linearized after stop still starts the orb.

Delivery is strict FIFO with batching (decided 2026-08-10). When dispatch becomes possible, the store atomically freezes every message currently queued behind the head into one batch identified by the first message ID. Their content is squashed into one user message in FIFO order with one empty line (`\n\n`) between submissions; text and image blocks otherwise remain lossless. Messages admitted after the batch claim form the next batch and can never alter an in-flight retry's payload. Head-of-line blocking is intentional: it provides one obvious conversation order and avoids overtaking an ambiguous transport outcome. Terminal startup or delivery failure remains visible on every constituent message resource and does not silently discard a row.

**Which delivery failures are terminal (decided and implemented 2026-08-10, from the review of the first implementation).** The runtime client already classifies its errors as retryable or not, and the dispatcher must obey that classification, because head-of-line blocking turns a permanently undeliverable batch into a permanently wedged inbox: a `400 invalid_request`, an oversized payload, or any other answer the runtime will repeat for the same bytes is redelivered forever and every later message waits behind it. A **retryable** failure (timeout, unreachable runtime, `history_unavailable`) leaves the batch claimed and is retried on the next reconcile pass — the delivery is idempotent under its durable batch ID. A **non-retryable** rejection fails the whole batch in one write: every constituent row moves to `failed` with the runtime's sanitized reason in `last_error` and its wake intent cleared, which takes those rows out of the outstanding set so the next message is claimable immediately. Nothing is retried and nothing is discarded: the failed rows stay queryable through `POST .../messages/poll`.

That status is a product outcome, not an operator detail, so it is surfaced end to end: `OrbMessageView.status` reports `failed` with `error`, the orb page keeps every non-delivered message in view, and the web history renders such a message as a terminal user turn labelled `failed` with the reason beneath it, instead of a gray turn that stays "queued" forever. The reconciler additionally logs one `message-batch-failed` edge (`docs/lifecycle.md`).

### Local-subagent activity (2026-09-14; under validation)

`docs/subagents.md` requires one operation ID and busy status through root turns, leaf execution/cleanup and result-wake handoff. Aggregate busy must not be confused with root readiness: input during a child-only interval triggers a root turn within the existing operation, while input during whole-operation cancellation remains pending for the next operation. Completion history and child outcomes precede aggregate `operation_finished`; Luna remains detached and is scheduled only after aggregate settlement. The DST-first plan covers arbitration with existing inbox/turn-start barriers and consistent live/health/pull activity. The adapter now applies those same delivery rules to aggregate operation ownership; this is not a second protocol or a child-session replication endpoint.

**Live child projection (implemented locally 2026-09-14).** `subagents` replaces the current operation's complete active-child roster. Synchronization sends it after operation/tool reconstruction and before status; subsequent admissions, starts, cancellation and terminal releases publish changes. An empty roster means no currently owned child work, not aggregate idle. Queued admissions and cancelling/finishing holds remain present until release. The browser ignores mismatched-operation rosters and clears them on disconnect, synchronization reset and operation retirement/change; old history cannot restore live claims. The existing connection notice distinguishes disconnection from confirmed inactivity. Task identities/descriptions/phases are display data, not lifecycle drain authority; no private transcripts or new persistence endpoint are introduced. Durable root lifecycle edges retain diagnostic provenance (`docs/subagents.md`).

### Atomic runtime delivery choice

The existing per-orb reconciler is the dispatcher: inbox commit wakes it immediately, and later ordinary scans recover work after process death. No broker, queue service, or fourth background loop is added. When the orb is running it calls an authenticated, idempotent runtime HTTP operation keyed by the durable batch ID and carrying all constituent message IDs. The runtime serializes it through the same mutation executor as live abort requests, then chooses from its authoritative activity at that instant:

- busy agent operation → call Pi with `deliverAs: "steer"` and associate the message with the existing operation;
- idle runtime → trigger an ordinary new agent turn and allocate a new operation ID;

The choice is state-derived, not browser-selected and not based on the control plane's lagging ~10-second activity observation. Consequently the API has one message shape and no `delivery` input enum. The result/status may report the observed delivery mode for explanation.

For that instant to be authoritative, activity must not lag acceptance: an accepted agent submission — from either ingress path — claims its operation ID and marks the runtime busy synchronously, and a delivery waits for any submission that has not yet reached the harness's turn start before it classifies itself. Otherwise both paths read `idle` inside the same window, are promised operation IDs for the same turn, and one of them is left holding an ID that names no operation (fixed 2026-08-11; the correlation contract and the harness ordering it depends on are in `docs/pi-adapter.md`).

`expectedHeadId` is intentionally absent from this command. A durable FIFO is append intent: concurrent tabs are ordered by database admission, and messages queued behind another message cannot all validly name the same eventual Pi head. Checking the replica head would also be unsound because live history may be ahead of PostgreSQL.

### Exactly-once logical message without a second marker

PostgreSQL is authoritative before delivery; Pi's session file is authoritative after delivery. A finite HTTP acknowledgement cannot atomically commit both stores, so request IDs held only in runtime memory are insufficient: a crash after Pi appends but before the control plane marks delivery would otherwise duplicate the message.

For Pi, deliver the squashed batch as one `custom_message` with `customType: "pi-orb.user-message"`, `display: true`, the combined text/image content, and `details.messageIds`. `triggerTurn: true` plus `deliverAs: "steer"` implements the busy case; idle delivery triggers a normal turn. The Pi adapter maps this particular custom type to normalized `MessageRecord { role: "user" }` rather than to a generic event. It therefore looks and behaves like today's user message, enters model context as a user message, and costs no extra history record.

The runtime checks both persisted session entries and its in-memory pending-batch-ID set before enqueueing. A retry finds one of three states: persisted means the whole frozen batch was delivered; pending in this runtime means still queued; absent means safe to enqueue (including after a restart that lost Pi's in-memory steering queue). The control plane marks every constituent inbox item delivered when the corresponding history record is replicated, in the same transaction as that record. This closes acknowledgement-loss and runtime-restart races without pretending to provide a cross-database transaction.

Replication may win that race, and the delivery note must survive it (fixed 2026-08-10; found at ~1 schedule in 20 000 while de-flaking the batching scenario). The observed classification — `turn` versus `steer`, and the runtime's operation ID — is written by a *second*, separate store call after the delivery returns, and a history pull can commit the inbox record first. The note therefore applies to `queued`, `delivering` **and** `delivered` rows, and never downgrades a delivered row's status; when it was restricted to outstanding rows it silently matched nothing and the classification was lost for good, so the UI could never say how the message had been delivered. The store contract pins this ("records a delivery note that replication already marked delivered"), and the lifecycle DST forces the losing order rather than hoping for it (`note-after-replication-commit`).

Other harness adapters must provide the same durable client-message identity in their native record or a sidecar ledger on the authoritative orb filesystem. If a harness cannot do that, its capability must reject durable offline acceptance rather than silently weakening to duplicate-prone delivery.

### Observability and deterministic tests

Queued messages are user-visible resources: `POST .../messages/poll` restores their durable statuses after reload, and the UI shows each item once as a muted user turn with queued/steering state while delivery is pending. A delivered item remains provisional in that browser until the runtime record carrying its message ID has actually been applied locally; delivery status alone cannot retire it because inbox polling and live history are independent channels. Disconnected tabs can repair from PostgreSQL; open sockets exclusively own history ordering, so a concurrent HTTP response cannot bypass an atomic output handoff. Several gray turns may therefore collapse into one committed squashed user turn. A `failed` message is the exception that stays: it has no runtime record to collapse into, so it remains rendered with its reason until the user acts on it. Autonomous wake and dispatch decisions produce edge-only `lifecycle:` records containing orb ID and message ID but never message content.

The required deterministic schedules are all implemented in `apps/control-plane/src/domain/lifecycle.dst.test.ts` (2026-08-11). Every one of them asserts the same invariant set: exactly one replicated record per delivered batch, every message ID marked delivered exactly once, nothing lost, FIFO preserved, and no second agent turn started — checked against the runtime's own session as well as the replica, because a duplicate turn exists before replication observes it.

| Required schedule                          | Scenario                                     | What it forces                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| crash before Pi enqueue                    | `delivery-crash-before-pi-enqueue`            | The incarnation handling the first delivery dies before touching Pi: nothing pending, nothing persisted, answer lost. The batch must be redelivered. |
| crash after enqueue, before persistence    | `delivery-crash-after-enqueue-before-persist` | The batch lives only in the runtime's in-memory pending set: retries must find it *pending* and not enqueue again; the crash then loses it and the control plane redelivers. |
| crash after persistence, before the ack    | `delivery-crash-after-persist-before-ack`     | The record is durable and every answer is lost. Redeliveries dedupe against the persisted record and replication alone marks the rows delivered; the classification is the acknowledgement's payload, so it is legitimately lost. |
| two control-plane dispatchers              | `two-dispatchers-one-delivery`                | Two processes with independent in-process state dispatch the same claimed batch; exactly one call enqueues and exactly one `message-batch-dispatched` edge is logged. |
| send versus stop                           | `send-versus-stop`, plus `backstop-honors-any-wake-message` (send during `stopping`) and `stale-wake-intent-resurrection` (stop after a stranded intent) | A stop linearized after an admitted message wins: the message is preserved undelivered and does not resurrect the orb; a later send starts it and the older message still goes first. |
| idle stop versus send                      | `idle-stop-versus-send`, plus `idle-stop-message-race` (the replication side of the same race) | The idle deadline expires while a batch is undeliverable; no idle stop happens until the message lands, and the countdown then resumes from the delivery rather than from admission. |
| FIFO delivery across boot                  | `fifo-across-runtime-boot`, plus `backstop-honors-any-wake-message` | A message delivered before the boot is not re-sent to the rebooted runtime, the message queued while stopped lands behind it, and a settled tail resumes nothing. |

The `FakeRuntimeClient` models these windows with partial-delivery scripts (`crash_before_enqueue`, `enqueue_without_persist`, `persist_without_ack`) over a fake runtime that mirrors the real dedup contract: a persisted session record first, then this incarnation's in-memory pending-batch set — which dies with the process — and only then an enqueue.

The runtime protocol/browser E2E must cover stopped submission → startup → delivered history and busy submission → steer.

## Separate interactive-terminal socket (decided and implemented 2026-08-09)

The interactive orb terminal is intentionally not part of this agent frame union. The browser opens `/api/v1/orbs/{orbId}/terminal` with subprotocol `pi-orb.terminal.v1`; the control plane observes the same runtime address and proxies it to private runtime endpoint `/v1/terminal`. JSON text controls open/resize the PTY and report ready/exit/typed errors, while binary frames carry UTF-8 input/output. It has no agent hello, history cursor, request identity, persistence, replay, or model-context semantics. See `docs/terminal.md` for the complete contract and rationale.

## Multiple connections

Naturally support multiple simultaneous WebSocket connections to one orb. Each connection performs its own cursor-based synchronization and has its own bounded outbound writer. Complete history, runtime events, and status are broadcast; `request.result` is sent only to the requester.

All mutating requests from all connections pass through one runtime serial executor. `expectedHeadId`, operation IDs, and request IDs make races explicit: for example, two new-message requests against the same head cannot both succeed. This is not a commitment to multiplayer product features—there is no presence, attribution, shared editor state, or per-user permission model—but browser reloads and multiple tabs do not evict each other.

If a later deployment needs a single-connection policy, enforce it in the runtime rather than the control plane: atomically replace the active connection on a successful new hello and close the previous socket with a private replacement close code. Runtime enforcement works even with multiple control-plane instances. The first slice does not impose this restriction.
