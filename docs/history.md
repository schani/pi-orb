# History

The harness-agnostic history record model, where history is stored and who is authoritative, how Claude history replicates into PostgreSQL, how the browser loads and caches the transcript, and history search. Live wire frames: `docs/runtime-protocol.md`. Inbox receipts: `docs/inbox.md`.

History replication is correctness-critical: tool calls, results, persisted reasoning, compactions, model changes, custom entries and any other harness-persisted data must not silently disappear.

## Record model

Schemas: `packages/protocol/src/history.ts`.

- Statically type semantics common to Pi, Claude Code and Codex; keep native records losslessly in `overflow`.
- Harness system prompt/tool state is local execution configuration: keep its record identity and ancestry, never its contents (`docs/postmortems/2026-09-23-pi-system-history-replication.md`).
- Stable record IDs and parent IDs; use the harness's native ID whenever it has one. No conversation-order sequence numbers.
- Mixed content is typed blocks, because one assistant message interleaves text, reasoning, images and tool calls.
- Compaction is an additive record, not deletion. Scrollback keeps access to pre-compaction records and their inbox provenance.

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface HarnessSessionMetadata {
  id: string;
  timestamp?: string;
  overflow: Record<string, JsonValue>; // complete native session header
}

interface HistoryRecordBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  overflow: Record<string, JsonValue>; // original harness record; system prompt/tool state reduced to identity
}

type MessageRole = "user" | "assistant" | "system" | "developer" | "tool";

type ContentBlock =
  | { type: "text"; text: string; overflow?: Record<string, JsonValue> }
  | { type: "reasoning"; text: string; redacted?: boolean; overflow?: Record<string, JsonValue> }
  | { type: "image"; mediaType?: string; data?: string; url?: string; overflow?: Record<string, JsonValue> }
  | { type: "tool_call"; callId: string; name: string; arguments: JsonValue; overflow?: Record<string, JsonValue> }
  | {
      type: "tool_result";
      callId: string;
      content: ContentBlock[];
      isError?: boolean;
      patch?: string; // unified diff; optional presentation metadata
      overflow?: Record<string, JsonValue>;
    }
  | { type: "other"; contentType: string; data: JsonValue };

interface MessageRecord extends HistoryRecordBase {
  type: "message";
  role?: MessageRole;
  content: ContentBlock[];
  model?: { provider?: string; id: string };
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number; costUsd?: number };
  finishReason?: string;
  inboxMessageIds?: string[]; // durable inbox IDs this user message delivered, in order
  failure?: { message: string; diagnostics: string[]; context?: CodexFailureContext }; // present when finishReason is "error"; context: docs/pi.md
}

interface CompactionRecord extends HistoryRecordBase {
  type: "compaction";
  summary: ContentBlock[];
}

interface EventRecord extends HistoryRecordBase {
  type: "event";
  eventType: string;
  content?: ContentBlock[];
  inboxMessageIds?: string[]; // system inbox identities, acknowledged with replication
  sender?: { orbId: string }; // peer `orb.message` events (docs/inbox.md)
  alert?: { message: string; requestId: string }; // docs/orb-alerts.md
  custom?: { customType: string; display: boolean }; // iff eventType is "pi.custom_message"
  subagentTask?: { id: string; prompt: string; description: string }; // central child launch; never displayed
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
  }; // subagent receipts (docs/pi.md)
}

type HistoryRecord = MessageRecord | CompactionRecord | EventRecord;
```

New variants (configuration changes, attachments, command execution) may be added as real harness histories require. New fields are optional only when absence preserves required behavior; `inboxMessageIds` participates in delivery correctness. Contract changes ship directly; running orbs on an old contract are stopped and restarted.

**Tree state.** `id`/`parentId` describe ancestry, not which leaf is active, so the replica also stores an explicit `headId`. History is linear, so the head is normally the latest record.

## Storage and authority

Each harness has a private authority and a public transcript projection:

- **Pi:** private agent state and the public transcript both live in pi-orb's PostgreSQL. Private persistence covers native entries, conversations, checkpoints, settings, tasks, submissions and versioned application documents (`docs/pi.md`).
- **Claude:** the guest filesystem is authoritative: the retained native root JSONL, including pre-compaction records, plus a private prefix index and submitted-input journal. The control plane pulls public records into PostgreSQL.

The orb filesystem is assumed to survive process, container, VM and Spot failures; workspace files and native Claude history live there.

The public transcript (`history_records`) is a persisted, privacy-filtered normalized projection. It excludes private child transcripts and prompt/tool configuration, and transcript reads never depend on retained private state. The duplication is deliberate: simple privacy and independent lifetimes. Archive purges private state (native entries, repository snapshots, full artifacts) and keeps the public transcript; delete removes both (`docs/teardown.md`). Rejected: a thin public index over canonical native entries, which ties transcript retention to private retention.

The replica is the durable product history, not an orb backup or reconstruction source. Nothing may be started or reconstructed from it.

**Durability rule.** Only complete durable records are exposed; a committed cursor never names memory-only initialization or streaming output. Empty replicas permit session rotation, but a committed cursor never silently rewinds. Browser synchronization and request-head validation must observe one coherent projection; a partially scoped gate rejected every first message with `stale_head` (`docs/postmortems/2026-08-03-cursor-not-found.md`).

### Pi: atomic native and public commit

The atomic-commit and grouped-commit rules and memory-first progress are in `docs/pi.md`. Normal native `Storage.commit` projection consumes the complete write batch: only new immutable root entries are projected, with public parents seeded from the existing public cursor. Receipt and notification metadata come from that batch and the existing identity document, within the same native/public transaction. Projection preserves source identity, ancestry, timestamps, compaction boundaries, inbox provenance and typed failures. A projection failure cannot acknowledge delivery or retire live output; it emits the durable `history.projection_failed` edge and a public `history_unavailable` error. Archived transcripts from the removed host-Pi backend stay readable.

A loaded agent builds its full initial history once on open, then projects only committed suffixes and derives their display records with a retained ancestry-aware projector. Snapshots preserve coherent records and head, preserving record IDs, receipt semantics and live-output retirement ordering. Cold HTTP snapshots remain whole-history reads; browser grouping costs are described below. Native identity receipt metadata still grows with receipts.

Publication follows committed projection, not inference events, and continues while compute is creating, starting, stopping, stopped or failed, without guest transport. Explicit Stop and archive keep central history barriers; compute idle-stop or failure does not suspend the Harness or require guest drainage. Stopped history stays readable from PostgreSQL.

The central projection helper (`apps/control-plane/src/domain/agent-history.ts`) commits snapshot suffixes with the same cursor CAS as pull replication. Empty snapshots verify session metadata under the orb-row lock with the expected-cursor CAS before comparing headers: a changed cursor causes a fresh poll, not a stale-header failure; at an unchanged non-null cursor a header mismatch is fatal. Null-cursor rotation, passive empty snapshots and never-opened archival remain valid. The loaded central history cache is an optimization, not corruption authority: only `cursor_not_found` retries the committed persistence snapshot; a record missing from both is a fatal integrity error; legal cache lag emits no failure edge. Rejected: warm-up that hides startup schedules, weakened header equality, and read-purpose flags.

Failures persist bounded sanitized edges and surface affected outcomes to users, never private content.

### Claude: native files

The adapter reads only complete newline-terminated, fsynced JSONL entries. A private immutable prefix index fixes UUID-less identities and normalizes blocks. UUID-to-inbox provenance and the submitted-input journal commit before enqueue (`docs/inbox.md`). After a durable native receipt the inbox ledger drops duplicated text/images and keeps identity, request fingerprint and provenance. Streamed output retires atomically with its committed assistant record; pulls and reconnects expose only the published prefix while identity association is pending. Root terminal facts commit before idle. Index corruption, prefix mutation and a missing submitted-input receipt fail closed. Normalization uses native IDs where available, never rewrites committed IDs or content and never manufactures ancestry: `parent_tool_use_id` names a tool parent, not conversation ancestry. UUID-less entries keep order and are never content-deduplicated; same-ID content conflicts are immutable-history failures. Overflow never holds tokens, headers, auth URLs/codes, secret configuration or raw SDK options. Native configuration/progress payloads stay private; no child-transcript replication or control-plane write path into native history. Native mapping details: `docs/claude.md`.

## Claude pull replication

The control plane pulls; the runtime never pushes. Rejected: a push/mirror channel, which would bypass the replica's commit authority. One cursor per orb: the control plane stores the last committed record ID; the runtime returns complete records after it in native append order; the browser never uses this cursor for tree order.

```http
GET /v1/history?after=<record-id>&limit=100
```

`after` omitted reads from the beginning; `limit` defaults to 100, range `1..500`.

```ts
interface PullHistoryResponse {
  v: 1;
  orbId: string;
  runtimeInstanceId: string;
  activity: "idle" | "busy";
  session: HarnessSessionMetadata;
  records: HistoryRecord[];
  cursor: string | null; // equals `after` when records is empty, else the final record ID
  headId: string | null; // active head represented by exactly this returned prefix
}
```

No `hasMore`, snapshot token, sequence number or source head: a non-empty response means commit and pull again; an empty one means caught up at that instant.

- Each request captures one immutable view of persisted entries at its start; later appends belong to the next request.
- Only complete, durably persisted records; partial streaming output is never synthesized.
- Every persisted entry after `after`, including hidden custom and system-state entries, maps one-to-one to a record, so cursor continuity holds.
- Append order is parent-before-child; the deferred foreign key turns any violation into a replication-integrity failure, never a reorder.
- With records available, return 1..`limit`. Repeated requests against unchanged history are stable.
- `headId` never points beyond the returned prefix.
- Unknown non-null `after` → `409 cursor_not_found` (never a silent full replay). Malformed query → `400`. Runtime not ready → `503 history_unavailable` (retryable).

`orbId` detects routing mistakes. A successful pull doubles as the running-orb liveness and activity signal; `/v1/health` remains for readiness and diagnostics. `session.id` prevents merging a replacement session: the first successful pull stores the complete session header on the orb row and every later pull must match it exactly.

**Commit.** Each non-empty response commits in one transaction: verify immutable session metadata and duplicates, insert records, update `replicated_head_id`, and advance `replication_cursor` with compare-and-swap on the cursor the poll started from. An empty response may initialize or verify session metadata under the same CAS but does not advance the cursor. On CAS conflict the loser rolls back and repolls from fresh state before judging session integrity. No lease or lock is held across the runtime request; redundant pollers are safe. A failed transaction leaves the cursor unchanged. Records are immutable by ID: an existing `(orb_id, record_id)` is accepted only if `parent_id` and decoded JSON are structurally identical (key order and escaping do not matter). The same transaction marks inbox rows named by `inboxMessageIds` delivered and arms new alerts (`docs/orb-alerts.md`).

**Polling.** Active native runtimes are polled about every 10 seconds, immediately again after a non-empty response. Runtime, network and database failures retry from the unchanged cursor at normal cadence. Pull failures past the 30-second grace trigger the unreachable-runtime rule (`docs/lifecycle.md`). Pulling never blocks the agent. The loop recovers entirely from PostgreSQL after instance replacement.

**Isolation.** Each scan dispatches independent tasks with at most one in-flight operation per orb and lane: central input, history catch-up, and fallback naming. Input follows every dispatcher tick; history and naming follow pull cadence. Naming reads committed replica input and never runs inside catch-up. Held work on orb A cannot block orb B, and naming/history cannot occupy A's input lane; FIFO still waits for A's earlier receipt. Shutdown stops admission and drains admitted lanes; shutdown or a fatal lane stops catch-up at the next safe boundary (admitted I/O and its commit finish) and returns `yielded` with the committed count. Lifecycle drains omit the stop signal and require a verified empty response. An unexpected worker rejection emits one content-free `poll-task-crashed` edge (orb, lane, `unexpected`) and rejects the supervisor. Rejected: a joined concurrent sweep (catch-up still starves input) and unbounded peer catch-up (masks shutdown and fatal lanes).

## Shutdown barrier

Shutdown does not wait for the agent to settle; the requester accepts interrupting active work. Before stopping a native runtime the control plane pulls and commits until a pull returns no new records, then requests host stop. A retryable pull or commit failure blocks the stop and leaves the host running.

Transport failures, `503 history_unavailable` and transient database errors are retryable; interrupted or unparsable bodies are transport failures, not integrity failures (`docs/runtime-protocol.md`). `409 cursor_not_found`, session mismatch, orb mismatch, record conflict and mapping/validation failures are replication-integrity failures. On integrity failure one transaction marks the orb `failed` with a typed error, revokes the runtime token and records an incarnation-bounded discard fence; shared reconciliation then disposes compute while keeping the filesystem for manual inspection. The failure claim must commit before disposal: disposing first let the drain reconciler observe a stopped host and mark the orb cleanly `stopped`, losing the integrity signal. Recovery from integrity `failed` is manual; a later start hits the same error.

Drain exceptions (never-ready orbs, absent or already-stopped hosts) are in `docs/lifecycle.md`; an undrained host's stopped history is complete only up to the last committed pull until the next start. In-progress records are not replicated; a record completed after the final empty pull stays on the filesystem and is pulled after the next start.

## Schema

Relational keys, parents, cursors, heads and the session null-pair are SQL columns; record and session payloads are PostgreSQL `json`, not `jsonb` (migration `044_lossless_history_json.sql`). JSONB and SQL field extraction can reject valid history strings (escaped NUL, lone surrogates); the drivers decode `json` losslessly. The PostgreSQL adapter checks serialized record ID/parent and session ID against the relational keys on writes; SQL checks only `json_typeof`. Reject character replacement, skipped records and premature delivery. Postmortem: `docs/postmortems/2026-10-13-claude-history-nul.md`.

```sql
-- replication columns on orbs
harness_session_id text,
harness_session_header json CHECK (harness_session_header IS NULL OR json_typeof(harness_session_header) = 'object'),
CHECK ((harness_session_id IS NULL) = (harness_session_header IS NULL)),
replication_cursor text,   -- FK (id, replication_cursor) → history_records, DEFERRABLE INITIALLY DEFERRED
replicated_head_id text,   -- FK (id, replicated_head_id) → history_records, DEFERRABLE INITIALLY DEFERRED

CREATE TABLE history_records (
  orb_id uuid NOT NULL REFERENCES orbs(id),
  record_id text NOT NULL,
  parent_id text,
  record json NOT NULL CHECK (json_typeof(record) = 'object'),
  inserted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (orb_id, record_id),
  FOREIGN KEY (orb_id, parent_id) REFERENCES history_records(orb_id, record_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX history_records_parent_idx ON history_records(orb_id, parent_id);
```

`record` stores the complete normalized `HistoryRecord`. There is no conversation sequence column: snapshot order follows `parent_id` back from `replication_cursor`, or from an explicit internal anchor. `replication_cursor` is the final committed record in append order; `replicated_head_id` is the latest active head whose record is present, never a source head beyond a partial batch. Replication changes neither `state_version` nor `state_changed_at`, and lifecycle updates never touch replication fields.

Readers lock both relation orders (snapshots `orbs` then history; record joins history then `orbs`). A migration needing exclusive locks on both must take them with `NOWAIT` inside an exception block catching only `55P03`, releasing partial locks before backoff (044: 120 attempts, 0.25 s), and fail before DDL on exhaustion. Postmortem: `docs/postmortems/2026-10-13-history-migration-deadlock.md`.

Repository access uses explicit `BEGIN`/`COMMIT`/`ROLLBACK`, with every driver call wrapped in `ResultAsync.fromThrowable`.

## Snapshots and consumers

`readHistorySnapshot` reads records, session, cursor and head in one SQL statement. Pi snapshots and explicit anchors follow ancestry from `replication_cursor` (or the anchor). Default Claude snapshots return all committed records, grouping components by root timestamp/ID, ordering parent-before-child by timestamp/ID, and placing the cursor record last; unrelated-branch order is deterministic, not reconstructed (`docs/postmortems/2026-10-16-claude-compaction-scrollback.md`). Optional internal `atRecordId` returns an existing record's ancestors, including an inactive branch; it is not a public capability.

Consumers of the full `HistoryRecord`: runtime `/v1/history`, the in-orb transcript (`pi-orb transcript`, `orb_transcript`; replica-only, never wakes the target; `docs/control-plane-api.md`). The browser receives display projections.

**`orb_transcript` paging.** Not implemented. Always-on paging with a default 64 KiB JSON reply budget, overridable per page through `{orbId, cursor?, maxBytes?}`. Pages hold complete records; a single oversized record alone may exceed the budget. Pages carry minimal bounded metadata, stable parent ancestry and an opaque string `nextCursor`; only `nextCursor: null` means done, and every nonterminal page advances. No unpaged opt-out, fragments or silent truncation; existing transport caps stay. The tool prompt explains default, override, the oversized-record exception and following `nextCursor`. Every page reauthorizes and validates cursor membership in the target orb's current session. Rejected: a 256 KiB hard cap with JSON fragments and chunk/offset cursors. Browser/CLI recent-history paging is likewise byte-bounded for active, stopped and archived orbs, keeps the ordered cursor/live handoff, and fails visibly when one record cannot fit.

Large snapshots stream over HTTP/1.1 chunked transfer without `Content-Length` (Cloud Run's 32 MiB limit applies only to unstreamed responses). Node's pipeline handles backpressure and cancellation; a serialization failure aborts the connection rather than completing truncated JSON. Stream metadata is a plain JSON object. Large and interrupted responses log `history-streamed` / `history-stream-incomplete` edges with content-free `producedBytes` and `totalRecords`. Streaming bounds neither database reconstruction nor browser memory. Postmortem: `docs/postmortems/2026-09-27-history-response-size.md`.

## Browser display projection

`packages/protocol/src/display.ts` projects each `HistoryRecord` into a `DisplayRecord` through one pure function shared by browser `GET /api/v1/orbs/:orbId/history`, live `history.record` and reconnect replay. `DisplayHistoryView` is `{orbId, session: {id, timestamp?} | null, records, cursor, headId}`. Nothing is persisted; storage and replication are unchanged.

- Every record keeps its ID, ancestry, order and cursor role, including identity-only records; visible-row count never substitutes for the cursor.
- Visible prose and status stay inline. Reasoning, tool arguments/results, compaction summaries, subagent details and deliveries are addressed by `detailKey`: `recordId:blockIndex`, `recordId:summary`, `recordId:subagent`, `recordId:delivery`.
- Excluded: `overflow.native`, usage, undisplayed normalized blocks, full reasoning/arguments/results, result patches and inline base64. Details carry only renderer-consumed fields. `model` keeps only the optional provider; `failure` keeps only its message and a `providerTransportFailure` boolean.
- Each tool call/result is its own block; the browser pairs by `callId` within parent ancestry, preserving call order and unmatched-result fallback. Calls/results carry headlines, diff counts, failures and image presence; `targetId` distinguishes clipped paths.
- Empty/whitespace public reasoning blocks are omitted while record identity and detail indices remain; redacted notices and nonempty headingless reasoning survive.
- Reasoning `headline`: GFM ATX/setext headings and bold-only single physical lines, flattened and joined with ` · `; code and multiline bold excluded; redacted blocks use an empty headline. The parser is shared with live sends.
- Reasoning headlines and `read`/`edit`/`write` path headlines are capped at 1,024 UTF-8 bytes including the ellipsis; a read label's `offset`/`limit` range fits inside the cap. Unknown non-generating tools get an empty headline. Lazy activity headlines and `code`: `docs/activity-headlines.md`.
- Compaction outcome events keep optional `compactionOutcome: "failed" | "aborted"`.
- Subagent notifications add `subagent.messagePreview` (whitespace-collapsed, capped 1 KiB), computed only for display.

**Only human messages are user turns.** A user-role message counts as human only with an inbox receipt (`inboxMessageIds`). Any other user-role message without tool results projects to an `agent.delivery` event: `kind` from the Claude native origin (`task-notification` without `subkind` → `task`, `scheduled-trigger` → `scheduled`, `peer-send-message`/`session-inbox` → `peer`, otherwise `injected`), a capped headline from `<summary>` or the first non-empty line, and detail `<id>:delivery` with the full text. Native `isMeta` entries without a task-notification origin stay hidden. Content-free `claude.task_notification` events project as non-expandable `task` rows. Rejected: an origin allowlist (every new CLI origin shape leaks again) and hiding content (deliveries should be inspectable, just not attributed to the user). Peer `orb.message` events keep sender and body (`docs/inbox.md`).

The `claude.auth` attachment event keeps identity/ancestry but no displayed prose; connection status belongs in the credential UI. Claude native compaction metadata and command echoes are hidden by the same projector using retained native flags (`docs/claude.md`). Classification uses `eventType` and native flags, never literal text.

## Browser loading and live handoff

On a cache miss:

1. The browser requests orb metadata and history in parallel.
2. One consistent database read returns projected records, `headId` and cursor `C`.
3. The control plane resolves or starts the host while the browser renders history.
4. The browser opens the live socket and sends `C` in `client.hello`.
5. The runtime replays complete records and reconstructing events after `C`, then streams live output.
6. Stable IDs deduplicate records crossing the database/live boundary.

The control plane never derives replica writes from WebSocket frames and never inserts submitted messages optimistically; records enter the replica only through native commit (Pi) or pull (Claude). The browser may therefore see live records before the replica does.

## Lazy detail

Control-plane routes `/api/v1/orbs/:orbId/details/:recordId/:detailKey`, `/details/live/:operationId/:blockId` and the image route (`docs/control-plane-api.md`) authorize, then read one record from the store. A replica gap may fall back to an already-running runtime through the runtime client (`docs/runtime-protocol.md`), including during stopping/archiving; stopped and archived reads use only the replica. Detail reads never wake compute or construct a Harness. Session identity fences both paths. Responses reuse the runtime shapes (`docs/runtime-protocol.md`), private and no-store. Missing orb/detail 404, session mismatch 409, unavailable runtime/storage 503, malformed query 400; missing detail is not a missing orb. Failures show scoped Retry and log a content-free `display-detail-read-failed` edge with source and reason.

Browser reads:

- Expanding a category needs no fetch. Opening a call reads only its addressed detail; a completed command fetches arguments and result separately, and a known result fetches arguments only when the empty-result fallback needs them. A completed command shows its full command.
- An open running disclosure polls live HTTP about once per second, one in-flight read per key; active calls use one snapshot. Committed records replace transient blocks through `detailAliases`, keeping the disclosure open; the committed detail is fetched on transition.
- A read captures its owner when it starts; a response cannot grant an old result to a new owner. Collapse, disconnect, navigation, deletion, full sync and session replacement fence late responses. Stable detail context depends only on semantic inputs, so typing and metadata rerenders do not rerun `HistoryView`.
- Images use an authenticated binary route and an `imageRef` naming the source content index, never a sparse projected position. Remote HTTP(S) image URLs stay browser-managed: no JavaScript fetch, proxy or SSRF path.

Rejected: per-viewer revisioned WebSocket subscriptions (ordered snapshot/patch handoff and server state), fetch-on-open/final-only (stale running disclosures), and a group-fetch manifest (another request and invalidation layer).

## Browser transcript cache

One app-owned, injectable cache (`apps/web/src/lib/transcript-cache.ts`) survives route changes within a tab and is discarded on reload. Tests construct isolated instances. No persistent browser storage, prefetching, hidden mounted conversations or background sockets for inactive orbs.

**Contents.** Per orb: harness session ID, ordered complete display records, last-applied cursor and head, published atomically. Also committed detail bodies and local image `Blob`s, keyed by orb/session/record/detail (and source image index). The cursor is null for empty history or names the final retained record; a non-null head names a retained record; entries are full parent-closed prefixes. Never cached: pending requests, connection/capability authority, settings, busy state, operation IDs, live blocks, running detail snapshots, timers, terminal sessions or errors. Restoration fills transcript fields into otherwise fresh conversation state.

**Admission.** Publication comes from applied committed history, never token patches, typing or metadata polls; the reducer stays pure and a narrow boundary publishes accepted snapshots. Admission checks IDs/cursor/head and sums memoized per-record sizes without re-validating or cloning. Publishing an older applied prefix is safe; publishing a cursor beyond retained records is not.

**Budget.** 256 MiB of conservatively estimated data shared by snapshots, details and blobs, evicted LRU by bytes only; no entry-count limit, no TTL. A single oversized entry is not cached and evicts any stale entry for that orb. Eviction releases cache references, not the active view's records or object URLs (the view owns URLs and revokes them on change/unmount), so the budget is not a heap cap.

**Navigation.**

- Miss: parallel metadata and history load; the outgoing conversation stays visible and inert, and returning to it cancels the switch.
- Hit: show the cached transcript immediately as read-only/provisional while fresh metadata loads. Typing and drafts work; sends, lifecycle actions, live connection, terminal and uploads wait for fresh metadata and their own readiness. Success updates the mounted view in place without remount or reader-position reset. Metadata failure keeps provisional history with scoped Retry and grants no authority. Cached details/images render provisionally; uncached reads wait for fresh ownership, and request creation yields one microtask so abandoned StrictMode setups send nothing.
- Running hit: skip the history GET and connect with the cached cursor; live replay supplies missed records. Initial live catch-up owns inbox gaps, including while `closed`/`connecting`; only a `retrying` transport admits HTTP replica repair.
- Non-running hit: revalidate once through the full-history endpoint in the background, and again on every non-running lifecycle change (including `stopping`→`stopped` and `archiving`→`archived`, since the first transitional snapshot can precede the final drain). Coalesce with delivered-inbox repair; no polling loop.
- A failed refresh keeps valid cached records with scoped Retry. A confirmed 404 or deletion invalidates the cache and shows the orb-specific missing page at the requested URL; late callbacks cannot recreate the entry. Project deletion evicts that project's entries.

**Synchronization and stale responses.** One navigation/load ownership token plus per-entry writer ownership gate both visible publication and cache writes (including A→B→A). Cancellation is discard-only. Explicit invalidation advances an app-wide epoch; a load spanning it returns a visible retryable error rather than reinstalling older data. Then:

- `sync.started(mode: full)` clears the old snapshot; the replacement is admitted only after `sync.completed`, or after a later consistent full HTTP refresh while disconnected.
- A different session ID from a snapshot or welcome invalidates the entry; sessions are never concatenated. The same session on a new runtime instance stays valid.
- A null-session or empty replica is treated as lagging and cannot erase newer live history.
- A same-session HTTP refresh merges the replica prefix ahead of a newer live suffix without loss or duplication, keeps unchanged record identities, and still repairs a missing ancestor even when cursor/head match. A response started before a newer live synchronization cannot overwrite it.
- Cached state never restores request replay, live readiness or settings.

**Ordering invariant.** Every applied prefix is ordered and parent-closed; never advance a resumable cursor past a missing ancestor. A delivered inbox row stays provisional until its user record is applied or repaired, or a visible synchronization failure is shown (`TODO.md`). Postmortem: `docs/postmortems/2026-09-17-delivered-message-order.md`.

**Tail-first mounting.** `use-history-tail.ts` mounts the last 20 grouped display rows; upward reader intent within 160px of the top reveals 20 more while preserving a visible row's pixel anchor. The first mounted row is kept by identity, so appends never evict revealed rows. Initial tail placement and short viewports do not reveal rows. No buttons, background fill, spacers, eviction, IntersectionObserver or virtualization. The viewport is acquired in `useEffect` after ancestor refs attach; anchors are restored in layout effects and ResizeObserver callbacks. Wheel, non-editable scroll keys, pointer and touch input distinguish reader intent from compensation; native anchoring is disabled while custom compensation owns the viewport. The parent keeps tail pinning; the hook owns off-tail anchoring during prepends, appends and delayed growth, and its compensation advances the parent's geometry baseline so it is not mistaken for native movement. Grouping, call/result pairing and deduplication run over the whole history before slicing, memoized by records identity. This limits initial rendering only: browser Find misses unmounted rows, one huge group is unbounded, and server/parse/memory cost is unchanged. Rejected: a recent/full toggle (the user wants upward scrolling to load older rows automatically).

**Diagnostics.** A content-free navigation diagnostic reports hit/miss/bypass reason, orb ID, record count, accounted size, `cached_selection` vs `metadata_completion`, and metadata/history/sync timings. The bounded `pi-orb:history-mount` performance mark records retained/derived record counts, total/mounted rows and duration. Neither is a first-paint measurement.

The transcript summary and frame trace live in `window.piOrbDebug.dump()` (`docs/web-ui.md`).

## Search

Committed public history is searchable with `pg_textsearch` BM25 over one expression index on `history_search_public_text(history_records.record)` with the English text configuration (migration `052_native_history_search.sql`). PostgreSQL maintains it for every writer; no corpus, generated column, cache, trigger or dual write. The extractor is the privacy boundary: it follows transcript visibility and excludes private overflow, reasoning, image data and tool metadata. Changing the immutable extractor requires rebuilding the index in the same migration. The extension must be preloaded before the migration runs (`docs/deployment.md`). Rejected: a derived corpus with dual writes, `ts_rank` (not BM25), scoring a limited shortlist (changes ranking), and exact scoped statistics (reparses every eligible record).

**Retrieval.** One statement snapshot applies owner/project/orb scope and eligibility before the ranked `LIMIT`: Pi uses cursor ancestry, Claude all committed records; deleting projects/orbs are excluded. Nonmatching zero-distance rows are removed afterward. SQL sanitizes NUL/unpaired-surrogate escapes before decoding without selecting private text. Tokenization, stemming, stopwords, ignored oversized tokens, index-wide corpus statistics (not scope-local) and equal-score order are extension-native. Scores are positive BM25 (negated native distance), highest first. Snippets extract public text only for selected hits, centered on literal query terms. No exact candidate count or latency guarantee.

**Interfaces.**

- Tool `orb_search_history({query, scope?, orbId?, limit?})` returns `{hits}` or `{error: OrbAgentError}`; replay-safe. Description: "Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context."
- CLI `pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]` ("Search your committed public history with BM25.").
- Runtime `POST /runtime/v1/history/search`, query only in the JSON body, no-store. Success `{v:1,hits}`; each hit has `orbId`, `sessionId`, `recordId`, nullable `name`, `projectName`, `snippet`, `score`, `orbUrl`.

Scope defaults to the current orb; `project` is its project; `user` is all of the owner's orbs. An explicit orb ID is valid only in orb scope. All scopes are owner-only (narrower than transcript inspection), derived from the authenticated caller. Missing or foreign targets → `not_found`; deleting targets → `conflict`. `limit` 1–50, default 10. Queries need non-whitespace text, at most 4096 characters, trimmed but not tokenized by the service. `OrbAgentOperations` validates after its actor gate; stopped/archived targets need no wake. Logs record scope, hit count, latency and typed failures, never queries, snippets or database details.

**Versions.** Cloud SQL offers only `pg_textsearch` 1.3.1, which lacks upstream fixes for recycled-page corruption, deep post-filter retrieval and expression-index insertion; 1.3.1 is accepted on the unverified assumption that Google backported the fixes or the bugs are irrelevant. 1.3.1 doubles candidate redrives up to a 100,000 ceiling, which a large planner-pushed `LIMIT` can exceed. PGlite pins engine 0.5.12 and wrapper `@electric-sql/pglite-pg_textsearch` 0.0.14 (embedded extension 1.5.1), exact-pinned. Upgrade policy: never upgrade native `pg_textsearch` until Cloud SQL offers the exact target version, and then only with explicit user approval and version-specific qualification; never update the PGlite wrapper without inspecting its embedded version first. Registry freshness and upstream fixes do not authorize upgrades (`docs/dependency-audit.md`). The 1.5.1 spill/force-merge fix addresses a defect introduced by later nonblocking spills; 1.3.1 serializes spills under the lock and lacks it. Search benchmarks freeze source before preparation, bind runner/extractor/query/dataset hashes to receipts, record every attempt and never overwrite a failed one; their 2 s statement timeout is a benchmark budget, not an application deadline.
