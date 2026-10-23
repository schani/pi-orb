# History model and replication

## Pi 1.4 persistence (decision 2026-10-22; local, undeployed)

Migration `050_durable_sleeping.sql` widens only the existing task-status constraint. Existing task JSON holds `state.until`, checkpoint and restart count; no new columns/tables or history/auth rewrite. Native code-mode store checkpoints after 64 deltas change representation, not values, rewind or as-of-fork semantics. Trace carriers remain absent.

Graceful Harness close restores running tasks to pending through the same owner-fenced native/public transaction and `beginDrain` capability; it does not count as a crash. Revoked owners cannot publish close writes. Public snapshots derive interruption-pause notices from current blocked tasks without persisting duplicate alerts. Abort/child cancellation settles native work and removes the notice. `docs/pi-durable-evaluation.md` defines recovery policy.


## Claude replacement receipt barrier

**Decision — 2026-10-06; implemented locally, undeployed.** Automatic uncertain-worker recovery preserves native session/result identities and inbox receipt UUIDs. Verified compute replacement publishes idempotent interruption outcomes before releasing retained ownership; disposition publication/save failure remains failed. The controller pulls/commits canonical receipts before dispatching any retained inbox batch after recovery. It never marks an unacknowledged head delivered to unblock the queue. A repeated UUID is acknowledged from its retained native receipt, not inferred from compute disposal; new queued messages may then start ordinary turns. No old root inference or tool invocation is replayed. Recovery authority and attempt fencing: `docs/lifecycle.md`; runtime proof: `docs/claude-agent-sdk.md`.


**Claude local POC (2026-10-04; not deployed):** retained native root JSONL is resume authority, including pre-compaction records. The adapter reads only complete newline-terminated, fsynced entries. A private immutable prefix index fixes UUID-less identities and normalizes conversation blocks; UUID-to-inbox provenance and submitted-input journal commit before enqueue. No `SessionStore`, child-transcript replication, or control-plane native-history write service is introduced. Native configuration/progress payloads remain private. Streamed output retires atomically with its committed assistant record; pulls/reconnect expose only the published prefix while identity association is pending. After durable native receipt, the inbox ledger drops duplicated text/images and retains identity, request fingerprint, and provenance. Root terminal facts commit before idle. Boot continuation follows the 2026-10-06 decision below. Child holds reconcile with a different proved kernel/PID1 execution lifetime or matching controller-verified whole-compute disposal proof; unknown ownership otherwise fails visibly. Index corruption, prefix mutation, and missing submitted-input receipt fail closed. The existing pull-only PostgreSQL pipeline is unchanged. Details: `docs/claude-agent-sdk.md`.

**Claude boot history decision (2026-10-06; implemented locally, undeployed):** retained root history feeds Pi's pure boot plan. Platform boot claims persist before native submission and replicate with restart/execution identity, reason and interrupted head; the initial baseline stays hidden. Three automatic interrupted-root claims are available after genuine human input; compaction, system messages, boot receipts and completed notices do not reset them. Native boot input maps to `claude.boot_receipt`, not an ordinary user message. **Reconciliation decision — 2026-10-07:** manual compaction terminals retain `work: "compaction"`; boot planning ignores them along with native compact echoes/output, summaries and metadata. A compaction outcome must not settle interrupted root work or bypass its exhausted boot budget. Actual `compact()` completed/failed/aborted regressions reproduce the unclassified-terminal bypass before correction (`.context/main-push/compact-boot-red.log`). Crashes after a claim consume budget; exhaustion publishes a visible non-triggering decline. Continuation opens the retained root session without replaying children. Missing human-input receipts still fail closed; boot claims cannot establish human receipt. Successful authentication metadata stays in private persisted runtime state, outside conversation/replication. `docs/lifecycle.md`, `docs/runtime-protocol.md`.

**Claude drain decision (2026-10-05; local, undeployed):** metadata/settings and ordinary rotation retain ownership through native exit, actual stdout EOF, natural public iteration, tracked hooks and final durable native history, before SDK/MCP cleanup. SDK queue completion from `close()` is not transport EOF proof. Late owned root/child/task work or failed cleanup retains guards and failed health with bounded durable failure stage/reason; it cannot publish a completed terminal or admit idle/prepared state. Initialization overflow carries only sanitized stage metadata. Evidence and rejected early-close approach: `docs/claude-agent-sdk.md`, `docs/testing.md`.
## Central authority candidate (locally qualified 2026-10-05; undeployed)

The integrated candidate uses the same adapter against PostgreSQL and PGlite for private Durable conversations, checkpoints and settings; the earlier qualified process POC used SQLite. The control plane projects committed root entries into normalized product history; private child transcripts and prompt/tool configuration are excluded. Publication follows committed projection, not inference events. Stopped history remains available from product storage. A recovered-live-task `pi-orb.harness-restarted` entry is passive and model-unseen; it reports recovery, not guest-process death. Read-only paused reopen neither schedules unfinished work nor claims recovery is resuming. Central publication/pulling continues through compute creating/starting/stopping/stopped/failed without guest transport. Explicit Stop/archive retain central history barriers; compute idle-stop or failure does not suspend the Harness or require guest-history drainage. Claude uses the native guest-history pull pipeline below.

**Legacy Pi startup decision (2026-10-08; implemented locally, undeployed):** central startup compares the published session/header with the CURRENT Native root `orb.identity`; without a valid identity, only the exact prospective initial session ID is compatible. Legacy header-only sessions and partial Native initialization cannot establish reopen authority. Incompatible legacy sessions return terminal `legacy_backend`: “This orb uses the old Pi backend. Create a new orb to continue.” Malformed Native identity or missing Native cursor/head coverage returns terminal `history_integrity`, not a legacy verdict. Fresh compatible initialization and valid Native reopen remain allowed. No backend flag, schema change or history import is needed; passive public history and archives remain readable, and continuation uses a new orb.

The locked ownership-acquisition check precedes owner/metadata writes and refuses archived/archiving/deleting startup. Native transactions and ID allocation recheck compatibility under the existing orb/owner fence; already-owned cleanup during archiving/deleting retains the existing drain capability, while archived/sealed authority rejects mutation. Thus publication after preflight/acquisition cannot cross the initialization fence. Startup validates cursor coverage; private progress checks read only bounded current identity/public metadata, never scan transcript entries or republish history. Typed `StorageRejected` causes are decoded only at the Native adapter boundary. Explicit Start and terminal inbox outcomes follow `docs/lifecycle.md`; Claude is unaffected.

**Storage target decision (2026-10-04):** authoritative Durable conversations, checkpoints and settings must persist in pi-orb's PostgreSQL, not a separate SQLite database. SQLite describes only the earlier qualified POC, not candidate storage. Central authority does not remove the normalized, privacy-filtered product history projection or browser reconnect/gap recovery. PostgreSQL commit, ownership, host-loss and failover semantics require qualification; local SQLite restart evidence is insufficient. Rationale and supported-product parity scope: `docs/pi-durable-evaluation.md`. The PostgreSQL adapter and local real-database/process/Docker qualification passed; host-loss/database-failover qualification remains in `TODO.md`, and production adoption remains open under question 72 (Pi Durable) in `docs/open-questions.md`.

**Storage boundary decision (2026-10-04; question 74 (Pi Durable) resolved):** keep separate user-visible transcript and private agent history/execution state in PostgreSQL. Accept duplication for simple privacy and independent lifetimes. Private persistence includes native entries, conversations, checkpoints, settings, tasks, submissions and versioned application documents. The transcript is a persisted, privacy-filtered normalized projection, excluding private child histories and prompt/tool configuration; transcript reads must not depend on retained private entries.

**Atomic mutation contract (2026-10-04; integrated candidate):** native history mutations and all causally required public projection, enrichment, cursor and dedup updates commit or roll back in the same PostgreSQL transaction. Applicable receipt, admission and owner-fencing checks/updates belong in that mutation transaction. Readers never observe half-state; asynchronous projection repair cannot substitute for atomicity. The domain service owns the unit of work through its immediate adapter neighbor, without bypassing layers. Publish notifications only after commit; a lost post-commit notification is recovered through existing cursor catch-up/replay, not a second projection pipeline.

**Child steering projection decision (2026-10-14; implemented locally, not deployed):** native child `notify_parent` retains trusted parent JSON steering and call-identity deduplication (`docs/orb-alerts.md`). Reserved `submission.entry` provenance, not JSON text, identifies the placed entry. In the same native transaction it projects an existing `HistoryRecord` with `eventType: "pi.custom_message"`, `custom: {customType: "subagent-notification", display: true}`, `subagent: {kind: "notification", id: agent_id, description, message}` and `overflow: {}`. No early submission event, user-role record, `inboxMessageIds`, `record.alert` or raw native payload.

Public history retains the full plain message independently of private native state for replay, Stop/Start and archives. The existing notification/details loader serves it as `detail.body.message`. Only the compact display DTO adds optional `subagent.messagePreview`, computed by `capHeadline` from whitespace-collapsed actual text, capped at 1 KiB UTF-8; it is not persisted. No new database columns, document kinds, queue, acknowledgement cursor, backfill or child-transcript access.

`projectNotificationAdmission` in `apps/control-plane/src/adapters/durable/notifications.ts` rechecks Stop/sleep/owner admission fences under the native transaction orb lock; owned-drain permits cleanup, not notifications. Durable submission/provenance, retained public text and existing typed projection/detail failures provide diagnosis without new telemetry notifications. Root/CLI public alerts remain unchanged. Qualification: `docs/orb-alerts.md`.

Archive closes admission, drains admitted work and pending publication/durability, publishes the complete transcript and durably seals it, then deletes private agent history/execution state while retaining the transcript. Publication or seal failure blocks deletion. Sealing and private cleanup must remain consistent and idempotent across retries, crashes, concurrent cleanup and reopen; no private mutation may escape the archive/admission fence. Preserve stable projection/enrichment and cursor/dedup contracts. Use normal SQL migrations, without staged dual-store compatibility machinery.

Tests first, mandatory DST: atomic visibility/rollback invariants, crashes before commit, between logical writes and after commit before publication; duplicate/lost-ACK retries; stale owner/admission; archive cleanup races and reopen. Qualify atomicity and reopen against real PostgreSQL, not just simulations or SQLite. Persist bounded sanitized failure edges and expose affected failures to users, never raw private content. Focused atomicity, fencing, reopen and archive tests now exist, including real PostgreSQL/PGlite composed drain proof; frozen full local gates also passed (`docs/testing.md`). Production host-loss/database-failover validation is tracked once in `TODO.md`.

**Rejected alternative:** canonical native entries plus a thin public-history index/reference couples transcript retention to private agent-history retention. This is not the target; no zero-copy architecture is chosen. The candidate persists independent public bytes, including bounded artifact excerpts; archive purges all private native state, repository snapshots and full artifacts while retaining public records. Delete removes both. Owner lease time comes from the database; drain permits only an already-open storage instance's admitted cleanup, bounded by close/release/expiry/replacement. New submission/model/effect dispatch remains admission-fenced. Stable handles retain metadata only; passive reads query PostgreSQL without opening a Harness.

**Claude compaction mapping (decided 2026-10-06; local, undeployed):** native `compact_boundary` retains metadata/ancestry as an event; the flagged `isCompactSummary` user entry supplies the summary with immutable native UUID/parent. Manual command provenance suppresses its structured echo and instructions; native `isMeta` user entries become private metadata and exact stdout envelopes require compaction ancestry. Inbox-correlated and unrelated literal wrapper text remains human data. The shared display projector applies the same native-metadata classification to immutable normalized records using retained native flags and compaction-event ancestry. HTTP history and seeded runtime reconnect projections therefore hide internal artifacts without rewriting indexes, replica rows, IDs, cursors, or native files. Complete-prefix, partial-write and reopen checks apply to manual and automatic compaction. Typed failure/cancellation events are platform-only, not model context. Native contract and ownership rules: `docs/claude-agent-sdk.md`.

The harness-agnostic history model, the pull-only replication pipeline, and the PostgreSQL schema.

## Persistence decisions

**Name-only projects (decision 2026-10-22).** Migration `048_optional_project_repository.sql` allows `projects.repository_url` to be null. A project without a URL creates no repository snapshot or synthetic commit. Existing fenced resource events record readiness with a null commit and zero repository files/bytes. Retained repository snapshots still win after URL removal; managed instructions and private platform context retain their existing storage and ownership rules (`docs/pi-adapter.md`). No new resource mode or history representation is persisted.

- The orb filesystem is assumed not to disappear. Containers, processes, and VMs may stop, crash, or be preempted, but the same persistent filesystem is available when the orb restarts.
- The filesystem owns workspace files and native Claude history. Private Pi authority and public transcript projection live in PostgreSQL.
- Public history supports immediate browsing, not workspace or private-context reconstruction. Native Claude pulls and central Pi atomic projection feed the same product contract.
- **Decided and implemented 2026-08-10:** send-anytime user input is durably staged in a separate control-plane inbox before runtime delivery (`docs/runtime-protocol.md`). Inbox rows are commands, not optimistic history records; only the runtime's persisted record enters `history_records`.
- Native Claude replication is pull-only; the control plane polls active native runtimes approximately every 10 seconds. Central Pi publication is transactional and independent of guest readiness.
- Pulling and database persistence must not block the agent during normal operation.
- Temporary runtime, network, control-plane, or database failures are retried by the control plane from its last committed cursor.
- Before controlled native-runtime stop, the control plane repeatedly pulls and commits history until the runtime returns no new complete records. The drain requires a reachable runtime; the lifecycle rules define the exceptions (never-ready orbs, absent or already-stopped hosts, non-retryable integrity failures).
- A stop that completes without a reachable runtime — a crashed or already-stopped host — may leave final records unreplicated until the next start. In that case the stopped-orb history view is complete only up to the last committed pull. This is a deliberate, narrow weakening of the complete-replication goal in exchange for never stranding an orb in `stopping`.
- Explicit Stop may interrupt active work. Central Pi suspends persisted tasks; native Claude retains its guarded continuation/receipt contract. Stop is not terminal user Abort.
- If a pre-stop pull or database commit fails retryably, the stop must not proceed; the control plane retries while leaving the host running. A non-retryable replication-integrity failure (unknown cursor, session-header mismatch, mapping failure) instead abandons the drain and atomically marks the orb `failed`, revokes runtime authorization, and requests incarnation-bounded compute disposal; shared reconciliation removes compute while retaining the authoritative filesystem and everything not yet replicated (`docs/compute-replacement.md`).
- Cloud SQL for PostgreSQL is preferred over AlloyDB for the first cloud deployment because cheaper small configurations are sufficient for expected load. Private IP only, with automated backups and point-in-time recovery from day one — the replica is the durable product history.
- Default Docker development uses a PostgreSQL server. Container-restricted trusted testing uses embedded, filesystem-backed PGlite via `npm run dev:local`; it runs the same migrations and store SQL but does not validate PostgreSQL networking or multi-connection concurrency (`docs/stack.md`).
- Database access must be behind an interface so tests can use an in-memory/fake implementation where appropriate and local/cloud deployments can select different adapters.

## Transcript paging decision (2026-10-09; not implemented, implementation not authorized by this task)

`orb_transcript` always paginates with a default **65,536-byte (64 KiB)** budget for the complete UTF-8 JSON reply, including metadata, cursor and serialization escaping. The agent may override `maxBytes` on each page, including cursor requests; omission uses the default, never an unpaged opt-out. Records are atomic, complete `HistoryRecord` values: if one record cannot fit the requested budget, return that record alone (plus required metadata); that exceptional page may exceed the budget. Never silently truncate records or split JSON into fragments. The budget is not an unconditional transport/heap safety guarantee; existing transport/resource caps remain, including the 64 MiB cumulative serialized-reply guard, which can fail on an oversized record. No new override ceiling is chosen.

**Cursor decision (user-selected 2026-10-09):** keep an opaque string, not public cursor fields. **Minimal interface proposal (anchor removal not approved; no implementation authorized):** request `{orbId,cursor?:string,maxBytes?}`, response `{records,nextCursor:string|null}`. Internally the token encodes `{sessionId,nextRecordId}`; `nextRecordId` inclusively names the next unreturned record. Count metadata and encoding in the reply budget; omit the full session header. On the first page, select the session and current `replication_cursor` atomically: that record implicitly anchors traversal. Continue from the last returned record's `parentId`, latest-to-oldest. Immutable records and parent links preserve this traversal across appends, branch switches and compaction without separate anchor metadata, snapshot state or signatures unless existing policy requires them. `nextCursor: null` alone means completion; every nonterminal success advances, never an empty looping page.

An explicit initial anchor would label the original snapshot and allow validation that continuations belong to its ancestry. That was the original proposal's intent, not an implemented guarantee. It is unnecessary for stable backwards traversal or authorization when each page validates the caller, target, session and record. Proving membership in the *initial* ancestry would require retaining that anchor (or equivalent evidence); the minimal token alone does not prove it.

Layering: `apps/control-plane/src/adapters/durable/tools/orb-tools.ts` → `apps/control-plane/src/domain/orb-agent-operations.ts` → bounded store read, reusing parent-chain SQL in `apps/control-plane/src/adapters/pg/store.ts` and session-fenced lookup in `apps/control-plane/src/domain/ports.ts`. No OFFSET, whole-snapshot slicing, new tables, runtime wake or display projection. Reauthorize every page under existing caller/target policy; validate record membership in the target orb and current session, and fence deletion in the bounded read. Archive retains readable public bytes. Reject malformed/unknown/session-mismatched cursors and missing parents/cycles explicitly.

Current explicit transcript inspection is company-wide; discovery is owner-scoped (`docs/control-plane-api.md`; `orb-agent-operations.ts`). Public transcript callers cannot select arbitrary branch anchors: the optional internal `readHistorySnapshot.atRecordId` does not grant that public ability. Opaque encoding discourages the model from interpreting fields; it is not secrecy, authentication or a security capability. IDs scoped to orb/session validate sources, not token provenance. The proposal does not approve arbitrary committed-branch selection; implementing only existence checks on caller-crafted tokens would expose that ability, so the public branch policy must not be silently broadened.

Intended tool description: “Read an orb’s committed transcript in pages using `{orbId,cursor?,maxBytes?}`. `maxBytes` defaults to 65,536 bytes (64 KiB) for the complete JSON reply; override it on any page, including cursor requests. Pagination is always on. Records are complete and atomic: a record too large for the budget is returned alone with required metadata and may exceed `maxBytes`; existing transport/resource caps still apply. Pages follow stable parent ancestry latest-to-oldest. Pass `nextCursor` as `cursor` to continue until `nextCursor` is null.” This prompt contract is not implemented. Follow-up work is tracked in `TODO.md`; qualification includes memory/PGlite/PostgreSQL parity, DST races, Unicode/escaped JSON byte accounting, oversized records and termination. Telemetry records counts, bytes, latency and typed failures, never bodies/cursors.

**Rejected approach (2026-10-09):** the earlier 256 KiB hard cap used JSON text fragments and chunk/phase/offset cursor state to bound even oversized records. Rejected because atomic records and a single-record exception are simpler and avoid agent-side fragment reconstruction and extra state.

## Browser display projection (decided 2026-10-01; implemented locally, validation pending)

`history_records.record`, private native authority, runtime `/v1/history` pulls, and the in-orb `pi-orb transcript --json` response remain complete normalized `HistoryRecord` (native conversation data included). No data migration or change to replication cursor/commit is needed. Only browser `GET /api/v1/orbs/:orbId/history` and WebSocket `history.record` project records to `DisplayRecord`; `DisplayHistoryView` keeps `{orbId,session,records,cursor,headId}` with minimal nullable session `{id,timestamp?}`. The CLI is not a consumer of this browser display shape. Committed detail/image reads address one record by ID through the store, falling back to an already-running runtime when the replica lags; stopped and archived reads use only the replica and never wake compute. Session identity fences both paths. Details are not a second persistent copy. See `docs/runtime-protocol.md`, `docs/control-plane-api.md`, `docs/web-ui.md` and measurement evidence in `docs/transcript-cache.md`.

**Implemented locally (2026-10-04); full qualification in progress, not deployed:** lazy activity headlines derive only from complete immutable replicated sources. Migration `030_activity_headlines.sql` adds a separate first-winner cache keyed by orb/session/record/detail; history records, cursor and head never change. HTTP display history bulk-enriches cached strings without inference, leaving null on cache-read failure without per-read lifecycle events; runtime display emits unresolved null markers. Result eligibility follows parent ancestry, not append order; metadata-only ancestry deltas retain no raw source/private child data (O(records) storage, O(depth) lookup). Optional internal `readHistorySnapshot.atRecordId` supplies requested-record ancestors after the target exists, including an inactive branch. Explicit anchors retain ancestry-only semantics; default Pi snapshots follow `replication_cursor` ancestors, not `headId`. Default Claude snapshots follow the 2026-10-16 decision below. Archives retain cache; orb/session/source deletion cascades it. Atomic publication fences and the full contract are in `docs/activity-headlines.md`.

**Claude attachment status (decided 2026-10-06; local, undeployed):** adapter initialization appends the durable `claude.auth` event after native session attachment. This is not an SDK `auth_status` notification or control-plane credential-connect event. Browser projection retains its identity/ancestry but omits custom display metadata and prose; connection status belongs in the credential UI, not before a human transcript turn. Classification uses `eventType`, never literal text. Human messages and failure notices remain visible. Immutable indexes and replicas remain unchanged. Existing in-memory display DTOs require a page reload after updated serving processes; same-ID merges do not replace cached records.

**Non-human user-role records (decided 2026-10-12; supersedes the 2026-10-06 task-delivery privacy rule):** a user-role message requires an inbox receipt (`inboxMessageIds`) and human provenance; every human message in sampled Claude and Pi orbs carries one. Display projection turns any receipt-less user-role message without tool results into an `agent.delivery` event: `kind` from the Claude native origin (`task-notification` without `subkind` → `task`, `scheduled-trigger` → `scheduled`, `peer-send-message`/`session-inbox` → `peer`, otherwise `injected`), a capped headline from `<summary>` or the first non-empty line, and detail key `<id>:delivery` serving the full text. Native `isMeta` entries without a task-notification origin stay hidden. Claude mapping keeps these records as ordinary user messages with content. Retained content-free `claude.task_notification` events (written by the 2026-10-06 mapping) project as non-expandable `task` rows. Rationale: 2026-10-06 classified only `producer: "session-task"` origins; Claude Code 2.1.289 also emits bare `{kind: "task-notification"}` origins (resume-orphaned background tasks, `/btw`, `/upgrade`, subagent wakes), which rendered as human turns (orb `9841ec39`). Rejected: extending the origin allowlist — every new CLI origin shape would leak again; hiding content — the user wants deliveries inspectable, only not attributed to them. Notification delivery is not worker-termination proof and changes no ownership or activity state.

**Peer receipt extension (2026-10-14; local, undeployed):** trusted inbox system provenance maps peers to `orb.message` events with `sender:{orbId}`, original content and singleton inbox identity. Central atomic projection and Claude native mapping preserve complete receipt metadata. Native projection constructs the peer event directly from placed native content and its validated receipt; Pi and Claude use the same constructor after their own codec checks. Malformed peer receipts fail mapping, not human classification. Display retains sender/body independently of the sender orb or inbox row; plain-text transcript export prints source and body once, while JSON retains the normalized event. Generated model-context labels remain native and are excluded from public peer content. No new history table or sender-name snapshot. See `docs/orb-messaging.md`.

## Orb alerts (2026-09-30)

A non-model-context `pi-orb.alert` session entry maps to an event with typed `alert: {message, requestId}`. Live history and pull replication carry the same record. Only newly inserted alerts set `orbs.unread_alert_id`, atomically with the pull commit; duplicate pulls cannot re-arm a cleared alert. Acknowledgement verifies a replicated alert and compare-clears its ID without modifying history, lifecycle state, or replication cursor. Contract and tests: `docs/orb-alerts.md`.

## Harness-agnostic history model

### Principles

- Statically type semantics common to Pi, Claude Code, and Codex.
- Preserve native conversation records losslessly. Harness system prompt/tool state is local execution configuration: preserve its record identity and ancestry, but never its contents, in product history.
- Use stable record IDs and parent IDs to support a future tree.
- Do not put conversation-order sequence numbers in the public history model.
- Model mixed message content as typed blocks because a single assistant message can interleave text, reasoning, images, and tool calls.
- Treat compaction as an additive history record, not deletion. Product scrollback must retain access to pre-compaction records and inbox provenance, not merely their stored rows.

**Claude scrollback decision — 2026-10-16 (locally qualified, not deployed):** default `readHistorySnapshot` returns all committed Claude replica records; Pi defaults and explicit anchors remain ancestry-only. One SQL statement captures records, session, cursor and head consistently. Presentation groups components by root timestamp/ID, orders ready records parent-before-child by timestamp/ID, and places cursor last for browser sync. Without native append ordinals, unrelated-branch/tie order is deterministic, not reconstructed. Reads change no stored/native state. Runtime append and prefix-merge semantics remain unchanged; incomplete browser caches need reload. Evidence and rejected ordering: `docs/postmortems/2026-10-16-claude-compaction-scrollback.md`.

### Proposed types

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
   * Contains the original harness record and any data not represented by
   * normalized fields. System prompt/tool state is reduced to identity before
   * leaving the harness host; other records remain lossless.
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
      /** Unified diff, when the tool reported one. */
      patch?: string;
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

  /** Durable client message IDs this user message delivered, in order. */
  inboxMessageIds?: string[];

  /** Present when `finishReason` is `"error"`; `diagnostics` are diagnostic types. */
  failure?: { message: string; diagnostics: string[] };
}

interface CompactionRecord extends HistoryRecordBase {
  type: "compaction";
  summary: ContentBlock[];
}

interface EventRecord extends HistoryRecordBase {
  type: "event";
  eventType: string;
  content?: ContentBlock[];
  /** System inbox identities acknowledged atomically with replication. */
  inboxMessageIds?: string[];
  /** Authenticated peer identity on `orb.message` events. */
  sender?: { orbId: string };

  /** User-facing alert; request identity deduplicates CLI retries. */
  alert?: { message: string; requestId: string };

  /** Present iff `eventType` is `"pi.custom_message"`. */
  custom?: { customType: string; display: boolean };

  /** Central child launch metadata; omitted from browser display records. */
  subagentTask?: { id: string; prompt: string; description: string };
  /** Present iff the custom message is a subagent receipt. */
  subagent?: {
    kind: "notification" | "update" | "workspace_notice";
    id?: string;
    description?: string;
    status?: string;
    message?: string;
    notice?: string;
    error?: string;
    resultPreview?: string;
    durationMs?: number;
  };
}

type HistoryRecord = MessageRecord | CompactionRecord | EventRecord;
```

This is a proposal, not a frozen schema. In particular, configuration/model-change records, attachments, patches, and command execution may deserve additional typed variants after comparing real Pi, Claude Code, and Codex histories.

**Schema evolution (decided 2026-09-17).** Migrations must support a temporary overlap with old runtimes. New fields may be optional/defaulted only when absence preserves the required behavior; otherwise incompatible writes must be rejected at the write boundary with a typed, durable, user-visible outcome before commit. The protection must become effective atomically with the migration/backfill. `ToolResultBlock.patch` is optional presentation metadata: when absent, the UI omits `+`/`-` counts and shows call status. By contrast, `inboxMessageIds` participates in delivery correctness, so compatibility or rejection must preserve that behavior rather than merely make the schema parse. This supersedes manual fleet stopping as the standing migration rule. No dual-write policy, generic framework, or boundary implementation has been chosen.

### Tree state

`id` and `parentId` describe graph ancestry. They do not identify which leaf is currently active once branching exists. The replica therefore also needs an independently replicated `headId`.

The first version remains linear, so `headId` is normally the latest record. Keeping it explicit avoids a future schema migration when trees are enabled.

## Correct history replication

History replication is a correctness-critical subsystem. Tool calls, tool results, reasoning where persisted, compactions, model changes, extension/custom entries, and any other harness-persisted data must not silently disappear.

### Pull-only model and cursor ownership

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
- Only complete, durably persisted harness records may be returned. Partial streaming assistant output must not be synthesized into this endpoint.
- Every persisted harness entry after `after`, including hidden custom and system-state entries, maps one-to-one to a `HistoryRecord`; the adapter must not skip entries that would break cursor continuity. Pi system messages and compaction system checkpoints retain only identity in their mapped native overflow, so full prompt/tool configuration never enters either this pull response or live history frames. The authoritative local Pi JSONL remains unchanged (`docs/postmortems/2026-09-23-pi-system-history-replication.md`).
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

`orbId` detects host-routing mistakes. `runtimeInstanceId` and `activity` let the pull double as the running-orb liveness and activity signal; `GET /v1/health` remains for startup readiness, restart checks, and diagnostics. `session.id` is Pi's session UUID and prevents records from a replacement session being merged into the same orb replica. The session header is metadata rather than a history record, so it never changes the cursor or entry ancestry. The first successful pull stores the complete metadata on the orb row; every later pull must match it exactly. A mismatch is a non-retryable replication-integrity failure: the control plane never merges records from a different session and never silently resets the replica; it marks the orb `failed` with a typed error and requests compute disposal while preserving the workspace (no drain could succeed).

The control plane commits each non-empty response transactionally: verify immutable session metadata and duplicate rows, insert new records, update `replicated_head_id`, and advance `replication_cursor` with cursor compare-and-swap. An empty response may still initialize/verify session metadata, but does not advance the cursor. If the transaction fails, the cursor does not advance and the next poll requests the same range again.

No cursor is stored inside every history record, and Pi does not need a separate runtime outbox or replication journal. Its authoritative session history already provides the durable records and append order needed by the pull adapter.

### Polling and retries

The control plane is solely responsible for scheduling persistence work:

- poll every active orb at roughly a 10-second interval;
- treat a successful pull as the running-orb liveness/activity signal; pull failures persisting past the 30-second grace period trigger the unreachable-runtime restart rule of the lifecycle section (this proxy is no weaker than the health poll it replaced — either one proves only that the runtime process serves HTTP; live WebSocket health is observed by the proxy connection itself);
- after a non-empty response, it may pull again immediately to reduce lag;
- retry runtime, network, and database failures from the unchanged committed cursor at the ordinary polling cadence — no separate backoff schedule or retry state is needed in the first slice;
- use an optimistic cursor compare-and-swap so overlapping pollers cannot advance the same orb cursor incorrectly;
- use transactional idempotency so worker crashes and repeated pulls are harmless.

**Polling isolation decision — 2026-10-14 (local, undeployed):** production scans dispatch independent simulation-friendly tasks with at most one in-flight operation per orb/lane: central input, history catch-up, and fallback naming. Central input follows every dispatcher tick; history and naming follow their own pull cadence. Naming reads already-committed replica input through `orb-naming.ts`, never runs inside replication catch-up, and retains the existing conditional assignment/lease contract. No persisted state is added. Held health, inbox claim/delivery, history read/commit, naming inference, or sustained non-empty catch-up on A cannot block B's later inbox receipts. Naming/history also cannot occupy A's input lane; FIFO still waits for A's earlier canonical receipt.

A joined concurrent sweep was rejected: waiting for all workers before the next tick still lets sustained catch-up starve later input. Workers instead remain fenced in process-local lanes across scans. Shutdown stops admission and drains admitted lanes; unexpected worker rejection emits one content-free `poll-task-crashed` edge (orb, lane category, `unexpected` classification), then rejects the supervisor with the original error. Shutdown or a fatal lane stops further history catch-up rounds at the next safe boundary: admitted adapter I/O and its commit finish without cancellation. The optional polling stop signal returns `yielded` with the committed record count, not `caught_up` or a failure; yielding changes neither retry episodes nor cadence. Lifecycle drain callers omit this signal and still require a verified empty response. Unbounded peer catch-up was rejected because it could indefinitely mask shutdown or an already-recorded fatal lane. Existing typed retry/integrity handling remains unchanged. `apps/control-plane/src/domain/poll-concurrency.dst.test.ts` exercises the production `pollLoop`/`pollAllOnce` path with statically declared worker tasks, later B receipts before A release, same-orb input independence, duplicate fencing, and held shutdown drainage. `apps/control-plane/src/domain/loops.test.ts` covers crash supervision.

Each poll remembers the database cursor `C` used in its runtime request. Its commit transaction inserts/upserts the returned records and advances the cursor only if the database cursor is still `C`. If another poller advanced it first, the conditional update affects no row, the transaction is rolled back/discarded, and the losing poller starts again from the new cursor. No lease or lock is held while making the runtime request.

In cloud deployment, at least one Cloud Run instance remains provisioned with CPU allocated outside request handling, allowing an in-process polling loop to run continuously. The loop must recover entirely from PostgreSQL after instance replacement. If the service scales beyond one instance, redundant pollers are allowed; the database cursor compare-and-swap makes their commits safe without leader election or a polling lease.

### Database-first history loading and content-agnostic live handoff

**In-orb transcript inspection (decided and implemented 2026-08-27).** A running orb may read another orb's same consistent database snapshot through the bearer-authenticated `GET /runtime/v1/orbs/:orbId/transcript` route and `pi-orb transcript <orb-id>` (`docs/control-plane-api.md`). This is replica-only: it never starts or contacts the target runtime. The command therefore sees a sealed complete archive, but for an active target it may lag by the ordinary pull interval and omits partial streaming output. Default text rendering removes native overflow; `--json` preserves the complete replica snapshot, including native conversation data but not local-only system prompt/tool state. No second transcript representation or persistence path is introduced.

**Browser cache exception (decided and implemented locally 2026-09-15):** `docs/transcript-cache.md` adds a bounded tab-local cache of complete parsed records plus session/cursor/head. A running-orb cache hit checks fresh orb metadata and resumes the existing live connection from the cached last-applied cursor, without repeating the full replica read. A miss still uses the database-first flow below. Non-running hits show cached history and revalidate through the unchanged full-snapshot endpoint; no delta API, replication change, persistent browser store or runtime wire change is introduced. A lagging replica cannot erase a newer cached live suffix, and a session change/full sync cannot merge unrelated cached records. The CLI's replica-only full snapshot is unchanged.

**Field finding (2026-09-27; production validation 2026-09-28):** An unbounded full-history response for a stopped orb exceeded Cloud Run's response-size limit and returned an empty 500 (`docs/postmortems/2026-09-27-history-response-size.md`). The existing runtime pull's `after`/`limit` parameters do not page browser history. The unpaged full-snapshot contract remains unchanged. Browser history and in-orb transcript responses stream distinct display/full JSON shapes via HTTP/1.1 chunked transfer without `Content-Length`. Node's stream pipeline handles backpressure and cancellation (covered by a gated-writable scheduling test); a serialization failure aborts the connection rather than completing truncated JSON. Large successful responses and interrupted responses log orb-correlated `lifecycle: ... history-streamed` / `history-stream-incomplete` edges with content-free `producedBytes` and `totalRecords` through the control plane's `SimulationTask` logging sink (production Fastify logging is disabled; produced bytes may exceed bytes delivered on disconnect). Stream metadata is an internal plain JSON object, not arbitrary objects with custom `toJSON`. Google [documents](https://cloud.google.com/run/quotas) the 32 MiB HTTP/1 response limit only for responses without chunked transfer encoding or streaming. Local registered-route tests for browser and CLI snapshots each exceed 32 MiB; a real HTTP CLI client consumed >32 MiB without changing its three-second deadline. The deployed original orb returned 34,493,218 bytes through Cloud Run ops in 1.721 s and the same 4,675 records through the actual CLI in 2.887 s; the two snapshots had matching cursor and record hashes, and both new service revisions logged `history-streamed` with no `history-stream-incomplete`. This proves Cloud Run ops and CLI delivery, **not direct browser IAP**; the latter remains untested. Full Docker E2E passed 227/227 (`docs/deployment.md`). Streaming does not bound database reconstruction, application/browser memory, JSON parsing, or navigation cost; byte-bounded recent-history paging remains the scalability direction (`TODO.md`).

Opening an active orb on a browser cache miss should behave as follows:

1. The UI requests history from the control plane.
2. In one consistent database read, the control plane returns projected display records for all replicated records, `headId`, and cursor `C`.
3. The control plane resolves or starts the host while the UI renders database history immediately.
4. The browser opens a live connection to the control plane and sends `C` in `client.hello`.
5. The control plane routes the unauthenticated first-slice connection and acts as a content-agnostic proxy for data frames.
6. The runtime replays complete records and reconstructing live events after `C`, then continues with new live output.
7. Stable IDs let the browser deduplicate records that cross the database/live boundary.

The browser may see live content and committed-record notifications before the next persistence poll. The control plane does not inspect those WebSocket frames for persistence and does not optimistically insert submitted user messages—or any other proxied content—into the replica. User messages and all other records enter the replica only when the regular HTTP pull path returns the harness-persisted record.

“Content-agnostic” does not mean blind TCP forwarding: the control plane still owns host startup, routing, connection limits, and protocol-version negotiation. Authentication and authorization will also belong at this boundary when added after the first slice. The control plane does not interpret runtime application frames after handoff, with exactly two idle-auto-stop carve-outs on the browser→runtime direction (docs/lifecycle.md): `client.presence` frames are consumed by the proxy (the runtime has no use for tab visibility, though it ignores one defensively), and a `client.request` sniff refreshes the advisory `last_busy_at` before the frame is forwarded unchanged. Runtime→browser frames are never parsed.

### Controlled shutdown pull barrier

Shutdown does not wait for Pi to settle. The requesting user or parent agent accepts the risk of interrupting active work.

Before stopping the host, the control plane:

1. pulls after its current committed cursor;
2. commits the response and advances the cursor atomically;
3. repeats while each pull returns one or more records;
4. when a pull returns no new complete records, immediately requests host stop.

If a pull or database commit fails retryably, the stop does not proceed; the control plane retries while leaving the host running.

Drain failures are classified. Transport failures, `503 history_unavailable`, and transient database errors are retryable. `409 cursor_not_found`, a session-header mismatch, and mapping/validation failures are replication-integrity failures that no retry can repair. On an integrity failure the control plane abandons the drain and one transaction marks the orb `failed` with a typed error, revokes the runtime token, and records a discard fence through the current compute incarnation. Shared replacement-intent reconciliation then disposes compute while preserving the authoritative filesystem for manual inspection.

**Audit finding (2026-10-14; implemented locally, undeployed):** loopback-fetch tests reproduced false failure/discard of a healthy orb with committed history after body-read abort, socket interruption or non-JSON `503`; no reported incident. Reject transport/parse conflation: interruption does not prove corrupt history. The distinction in `docs/runtime-protocol.md` preserves retryability and genuine integrity failure/discard authority. Existing `lifecycle:` pull-failed/drain-blocked edges and typed `lastError` suffice; no new persisted state. [RED authority evidence](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/91be99a9-6192-4aa6-879b-d2c451a65af4/audit1/red-authority.log).

That order — claim the row, then dispose compute — is required, not incidental (DST-found 2026-08-06; generalized 2026-08-12). Stopping first raced the drain reconciler of the same `stopping` orb: it observed the host the integrity path just stopped, took the "already-stopped host cannot be drained" branch, and CASed the orb to a clean `stopped`, discarding the integrity signal. The durable failure/discard transaction now wins first, and the shared incarnation-bounded disposer is the sole cleanup owner (`docs/compute-replacement.md`).

The lifecycle rules add the remaining exceptions to the pull-until-empty barrier: an orb that never reached ready and has no session skips the drain entirely, and an absent or already-stopped host cannot be drained and is marked `stopped` directly, accepting the replication caveat stated in the persistence decisions. Recovery from an integrity-`failed` orb is manual by decision — inspect the filesystem, repair or abandon the replica — and stays manual until the system is demonstrably stable; automated ID-based reconciliation is deliberately not planned for the early slices. A later start of such an orb will hit the same integrity error and return to `failed` rather than corrupting the replica.

An in-progress record is intentionally omitted. If shutdown terminates the process before that record becomes complete, it is not replicated; this is part of the caller-accepted interruption risk. A complete record committed in the narrow race after the final empty pull and before process termination remains on the authoritative filesystem and will be discovered after the next start.

### Reconciliation and failure model

**Decision (2026-10-13; user-approved; deployed):** store complete history records and session metadata in PostgreSQL `json` (not `jsonb`). Migration `044_lossless_history_json.sql` converts both columns in place. Deploy `38484755289` applied 044 and validated all twelve transaction gates; its separate rollout monitor reported `regression` (`docs/deployment.md`). Production catalog/ledger and original-orb recovery were not independently verified. Existing PostgreSQL/PGlite drivers decode whole values losslessly, including escaped NUL, lone surrogates and nested keys. JSONB storage/casts and SQL payload field processing can reject valid history strings; keep payloads opaque. Native files and protocol shapes are unchanged. `json` avoids application read projections; no performance improvement is demonstrated.

**Migration locking decision (2026-10-13; deployed):** readers use both relation orders: snapshots read `orbs` then history; record JOINs acquire history then `orbs`. Blocking exclusive `orbs`, then history locks remove the original two-session cycle but a deterministic three-session probe proves another cycle with already-live record readers; that approach is rejected. Migration 044 instead attempts both exclusive locks NOWAIT inside an exception subtransaction catching only 55P03, releasing partial locks before backoff. Limit: 120 attempts, 0.25-second backoff (119 sleeps); exhaustion fails before DDL. Existing ALTERs run once in the same transaction; no persisted schema change or whole-migration retry is added. Durable contention/acquisition/exhaustion edges and validated migration-failure SQLSTATE diagnose outcomes. Evidence and production catalog limits: `docs/postmortems/2026-10-13-history-migration-deadlock.md`.

Keep relational keys, parents, cursors, heads and the session null-pair in SQL. The PostgreSQL adapter checks serialized record ID/parent and session ID against relational keys on owned writes. Duplicate comparison is structural; records/cursor/head/receipts commit atomically. Ordinary orb row mapping uses driver-decoded objects. Reject character replacement, skipped records, premature delivery and compatibility staging. `orb_messages` remains JSONB, outside this scope. Incident and qualification evidence: `docs/postmortems/2026-10-13-claude-history-nul.md`; follow-ups: `TODO.md`.

The filesystem is assumed to survive process, container, VM, and Spot failures. After restart, polling resumes from the database cursor and discovers remaining complete harness records.

For Pi, the adapter can enumerate every persisted entry. A full ID-based reconciliation endpoint or diagnostic mode may become useful as a backstop if the stored cursor is invalid or the adapter/session disagree, but it is not required to reconstruct the orb, and by decision all such repair remains manual until the system is demonstrably stable.

The replica is explicitly **not** an orb backup or reconstruction source. **Deletion requirement 2026-08-08:** permanent orb deletion removes replicated history together with the authoritative filesystem; no browsable transcript is retained. Database backup/PITR copies age out under infrastructure retention and are not presented as immediate cryptographic erasure. See `docs/orb-deletion.md`.

**Archival implemented 2026-08-08:** `docs/orb-archival.md` makes the replica the authoritative *read-only transcript* only after an archive has restored the runtime if necessary, waited for idle, completed pull-until-empty, and durably sealed its cursor/head before destroying the filesystem. It remains forbidden to reconstruct or start an orb from that replica: checkout files and runtime state are intentionally gone. A seal failure blocks resource destruction rather than silently retaining an incomplete transcript.

**Durability rule:** replication exposes only complete durable records; it never commits a cursor naming memory-only initialization or streaming output. Empty replicas permit session rotation, but a committed cursor cannot silently rewind. Browser synchronization and request-head validation must observe one coherent projection; partial gating can reject every first message. Earlier evidence: `docs/postmortems/2026-08-03-cursor-not-found.md`.

## Minimal PostgreSQL schema

The initial slice used three tables: `projects`, `orbs`, and `history_records`; credential pointers were subsequently added for the broker. Replication state lives on the orb row. Orb deletion in `docs/orb-deletion.md` adds one minimal, short-lived tombstone table to record cleanup and fence stale external operations before history, the orb row, and the tombstone are removed together. Do not add user/auth, live-event, polling-job, generic host-resource, audit, or generic request-claim tables. The send-anytime feature adds one purpose-built `orb_messages` FIFO because stopped-orb acceptance cannot be represented by runtime history that does not yet exist; it must not become a generic job table. In-orb spawning (2026-09-08, `docs/orb-spawning.md`) adds purpose-built `orb_spawns` acceptance/provenance: source/target/project IDs, source incarnation, request fingerprint, and acceptance time, committed atomically with the orb and initial inbox row. These project-owned retry tombstones retain no prompt/history and survive orb deletion until project deletion cascades them; they are not a generic request/job table.

Application code generates UUIDs with Node's `crypto.randomUUID()`; PostgreSQL does not need a UUID extension. Migration `044_lossless_history_json.sql` defines the `json` payload columns below. SQL checks object type with `json_typeof(payload)`; payload identity checks belong at the PostgreSQL adapter boundary, without SQL field extraction.

```sql
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  repository_url text CHECK (btrim(repository_url) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orbs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),

  state text NOT NULL CHECK (state IN (
    'creating', 'starting', 'running', 'stopping', 'stopped', 'failed', 'deleting'
  )),
  state_version bigint NOT NULL DEFAULT 0,

  name text CHECK (name IS NULL OR (btrim(name) <> '' AND char_length(name) <= 80)),
  auto_name_lease_until timestamptz,
  auto_name_attempts integer NOT NULL DEFAULT 0 CHECK (auto_name_attempts >= 0),
  auto_name_next_attempt_at timestamptz,

  host_kind text NOT NULL,
  host_ref text,
  checkout_commit text,
  last_ready_at timestamptz,
  harness_session_id text,
  harness_session_header json CHECK (
    harness_session_header IS NULL OR json_typeof(harness_session_header) = 'object'
  ),
  CHECK ((harness_session_id IS NULL) = (harness_session_header IS NULL)),
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
  record json NOT NULL CHECK (json_typeof(record) = 'object'),
  inserted_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (orb_id, record_id),
  FOREIGN KEY (orb_id, parent_id)
    REFERENCES history_records(orb_id, record_id)
    DEFERRABLE INITIALLY DEFERRED
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

Orb naming reuses the `orbs` row rather than adding a job table (`docs/control-plane-api.md`). The nullable name is product state; no source discriminator is needed because generated assignment is conditional on null and later user updates simply replace the name. The lease, attempt count, and next-attempt time are restart-stable coordination for the asynchronous Luna call: a worker claims without holding a database lock across inference, and assignment remains conditional on the name still being null.

The single feature migration, `009_orb_messages.sql`, adds `orb_messages`, keyed by `(orb_id, message_id)`, with validated JSON content, a database-assigned insertion ordinal, `queued | delivering | delivered | failed` status, optional observed delivery mode/operation ID, sanitized error, timestamps, durable batch identity, and message-driven wake metadata. The `auto_start` wake bit distinguishes send-after-stop from stop-after-send without adding lifecycle state; it is set by admission whenever the orb cannot take delivery right now (`stopping`, `stopped`, `failed`) and cleared only by delivery, terminal failure, or an explicit stop — never by the wake it causes, so the backstop's start needs no follow-up write that could be stranded (`docs/lifecycle.md`). `wake_state_version` is the orb `state_version` the intent was admitted against: a `stopped` orb wakes for any outstanding intent, while a `failed` orb wakes only for an intent naming its current version, so a new send retries a failed boot exactly once and the version bump the wake performs retires the privilege without a second write. Admission itself performs no lifecycle transition (2026-08-11) — the reconciler's terminal backstop owns the single message-driven transition. `delivery_batch_id` lets claiming the head atomically assign every currently queued row to one batch while later arrivals wait for the next one. Singleton batches use the member UUID; multi-member batches derive a deterministic UUID from ordered membership. Cancelling an unadmitted member detaches remaining rows to queued/null-batch, so changed membership rotates identity; failure updates are fenced by the captured batch UUID. Central native admission validates source IDs/order, canonical payload/system, batch/status/operation and staged queued/placed native content under the same orb lock; terminal writes do not re-admit completed input. The replicated native record carries all constituent message IDs as the durable delivery identity; its replication transaction marks all of those rows delivered, and outstanding/status reads remain reload-safe.

`history_records.record` stores the complete normalized `HistoryRecord`, including lossless native conversation overflow and identity-only Pi system-state overflow. `orbs.harness_session_header` likewise stores serialized `HarnessSessionMetadata`; the query drivers decode both before returning adapter values. The few duplicated columns exist only for keys and tree traversal. There is deliberately no database conversation sequence number: snapshot order is reconstructed by following `parent_id` from `replication_cursor` by default, or an explicitly requested internal record anchor. `replicated_head_id` separately identifies the replicated active head; branching uses the same graph.

`replicated_head_id` means the latest active head whose record is present in the replica. A runtime pull may report a source head beyond a partial batch; do not expose/store that as the replicated head until the referenced record has been committed. `replication_cursor` always references the final committed record in append order and is independent of tree order.

History records are immutable by ID. A repeated pull may encounter an existing `(orb_id, record_id)` only if the stored `parent_id` and decoded JSON value are structurally identical; differing content is a replication-integrity error, not an update. Object-key order and JSON escaping do not establish a conflict.

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
