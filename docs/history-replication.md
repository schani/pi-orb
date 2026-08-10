# History model and replication

The harness-agnostic history model, the pull-only replication pipeline, and the PostgreSQL schema.

## Persistence decisions

- The orb filesystem is assumed not to disappear. Containers, processes, and VMs may stop, crash, or be preempted, but the same persistent filesystem is available when the orb restarts.
- The filesystem is the authoritative persistence mechanism for the orb. Pi uses its normal persistent session file there.
- Conversation history is replicated to the control plane for immediate browsing and durable product history, but the replica is not used to reconstruct an orb or Pi session.
- **Decided and implemented 2026-08-10:** send-anytime user input is durably staged in a separate control-plane inbox before runtime delivery (`docs/runtime-protocol.md`). Inbox rows are commands, not optimistic history records; only the runtime's persisted record enters `history_records`.
- Replication is pull-only in the first version. The control plane polls every active orb approximately every 10 seconds.
- Pulling and database persistence must not block the agent during normal operation.
- Temporary runtime, network, control-plane, or database failures are retried by the control plane from its last committed cursor.
- Immediately before a controlled stop, the control plane repeatedly pulls and commits history until the runtime returns no new complete records. The drain requires a reachable runtime; the lifecycle rules define the exceptions (never-ready orbs, absent or already-stopped hosts, non-retryable integrity failures).
- A stop that completes without a reachable runtime — a crashed or already-stopped host — may leave final records unreplicated until the next start. In that case the stopped-orb history view is complete only up to the last committed pull. This is a deliberate, narrow weakening of the complete-replication goal in exchange for never stranding an orb in `stopping`.
- Shutdown does not wait for Pi to settle. A user or parent agent may stop an orb during active work and accepts the risk of terminating an incomplete turn.
- If a pre-stop pull or database commit fails retryably, the stop must not proceed; the control plane retries while leaving the host running. A non-retryable replication-integrity failure (unknown cursor, session-header mismatch, mapping failure) instead abandons the drain, marks the orb `failed` with a typed error, and then stops the host; the authoritative filesystem retains everything not yet replicated.
- Cloud SQL for PostgreSQL is preferred over AlloyDB for the first cloud deployment because cheaper small configurations are sufficient for expected load. Private IP only, with automated backups and point-in-time recovery from day one — the replica is the durable product history.
- Default Docker development uses a PostgreSQL server. Container-restricted trusted testing uses embedded, filesystem-backed PGlite via `npm run dev:local`; it runs the same migrations and store SQL but does not validate PostgreSQL networking or multi-connection concurrency (`docs/stack.md`).
- Database access must be behind an interface so tests can use an in-memory/fake implementation where appropriate and local/cloud deployments can select different adapters.

## Harness-agnostic history model

### Principles

- Statically type semantics common to Pi, Claude Code, and Codex.
- Preserve the complete native harness record losslessly.
- Use stable record IDs and parent IDs to support a future tree.
- Do not put conversation-order sequence numbers in the public history model.
- Model mixed message content as typed blocks because a single assistant message can interleave text, reasoning, images, and tool calls.
- Treat compaction as an additive history record, not deletion.

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

`orbId` detects host-routing mistakes. `runtimeInstanceId` and `activity` let the pull double as the running-orb liveness and activity signal; `GET /v1/health` remains for startup readiness, restart checks, and diagnostics. `session.id` is Pi's session UUID and prevents records from a replacement session being merged into the same orb replica. The session header is metadata rather than a history record, so it never changes the cursor or entry ancestry. The first successful pull stores the complete metadata on the orb row; every later pull must match it exactly. A mismatch is a non-retryable replication-integrity failure: the control plane never merges records from a different session and never silently resets the replica; it marks the orb `failed` with a typed error and stops the host (no drain could succeed).

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

Each poll remembers the database cursor `C` used in its runtime request. Its commit transaction inserts/upserts the returned records and advances the cursor only if the database cursor is still `C`. If another poller advanced it first, the conditional update affects no row, the transaction is rolled back/discarded, and the losing poller starts again from the new cursor. No lease or lock is held while making the runtime request.

In cloud deployment, at least one Cloud Run instance remains provisioned with CPU allocated outside request handling, allowing an in-process polling loop to run continuously. The loop must recover entirely from PostgreSQL after instance replacement. If the service scales beyond one instance, redundant pollers are allowed; the database cursor compare-and-swap makes their commits safe without leader election or a polling lease.

### Database-first history loading and content-agnostic live handoff

Opening an active orb should behave as follows:

1. The UI requests history from the control plane.
2. In one consistent database read, the control plane returns all replicated records, `headId`, and cursor `C`.
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

Drain failures are classified. Transport failures, `503 history_unavailable`, and transient database errors are retryable. `409 cursor_not_found`, a session-header mismatch, and mapping/validation failures are replication-integrity failures that no retry can repair. On an integrity failure the control plane abandons the drain, marks the orb `failed` with a typed error naming the problem, and then stops the host: blocking the stop forever cannot make the replica complete and would strand the orb, while the authoritative filesystem still holds every complete record for a future reconciliation mechanism (see open questions) to repair the replica.

That order — claim the row, then stop the host — is required, not incidental (DST-found 2026-08-06). Stopping first races the drain reconciler of the same `stopping` orb: it observes the host the integrity path just stopped, takes the "already-stopped host cannot be drained" branch, and CASes the orb to a clean `stopped`, which wins the race and discards the integrity signal entirely. With the CAS first, that reconciler's own CAS conflicts and it re-reads a `failed` orb.

The lifecycle rules add the remaining exceptions to the pull-until-empty barrier: an orb that never reached ready and has no session skips the drain entirely, and an absent or already-stopped host cannot be drained and is marked `stopped` directly, accepting the replication caveat stated in the persistence decisions. Recovery from an integrity-`failed` orb is manual by decision — inspect the filesystem, repair or abandon the replica — and stays manual until the system is demonstrably stable; automated ID-based reconciliation is deliberately not planned for the early slices. A later start of such an orb will hit the same integrity error and return to `failed` rather than corrupting the replica.

An in-progress record is intentionally omitted. If shutdown terminates the process before that record becomes complete, it is not replicated; this is part of the caller-accepted interruption risk. A complete record committed in the narrow race after the final empty pull and before process termination remains on the authoritative filesystem and will be discovered after the next start.

### Reconciliation and failure model

The filesystem is assumed to survive process, container, VM, and Spot failures. After restart, polling resumes from the database cursor and discovers remaining complete harness records.

For Pi, the adapter can enumerate every persisted entry. A full ID-based reconciliation endpoint or diagnostic mode may become useful as a backstop if the stored cursor is invalid or the adapter/session disagree, but it is not required to reconstruct the orb, and by decision all such repair remains manual until the system is demonstrably stable.

The replica is explicitly **not** an orb backup or reconstruction source. **Deletion requirement 2026-08-08:** permanent orb deletion removes replicated history together with the authoritative filesystem; no browsable transcript is retained. Database backup/PITR copies age out under infrastructure retention and are not presented as immediate cryptographic erasure. See `docs/orb-deletion.md`.

**Archival implemented 2026-08-08:** `docs/orb-archival.md` makes the replica the authoritative *read-only transcript* only after an archive has restored the runtime if necessary, waited for idle, completed pull-until-empty, and durably sealed its cursor/head before destroying the filesystem. It remains forbidden to reconstruct or start an orb from that replica: checkout files and runtime state are intentionally gone. A seal failure blocks resource destruction rather than silently retaining an incomplete transcript.

**Field finding (2026-08-03) — first real `cursor_not_found` integrity failure.** An orb failed with `replication_integrity: cursor_not_found` on its second start. Disk forensics proved the SDK had never written the session file — it deliberately does not persist until the first assistant message exists — so the control plane had replicated in-memory-only init events and committed one as its cursor, which the idle stop then discarded with the container. Full forensics: `docs/postmortems/2026-08-03-cursor-not-found.md`. The resulting design rules:

**Fix implemented (2026-08-04): the replication flush gate.** The snapshot served to the control plane's history pull (`replicationSnapshot`, composing `gateUnflushedSnapshot` with `sessionFlushed` in `pi/session-flush.ts`) serves zero records and a null head while the SDK has not written the session file; `sessionFlushed` observes file existence rather than mirroring the SDK's internal first-assistant-message heuristic, so the gate degrades to a no-op if a future SDK flushes eagerly. The replica therefore stays empty until the first flush, and a committed cursor can only ever name a durably-persisted entry. **The gate applies to the replication pull only.** Every browser-facing view — connect-time sync, the live record publisher, and the request gate's head — stays ungated: the browser path is upsert-based and full-resyncs on an unknown cursor by design, and (learned the hard way on the first deploy of this fix) gating only part of the browser-facing surface desynchronizes the head the client sees from the head its requests are validated against, rejecting every first message with `stale_head`.

**An empty replica pins nothing (corollary, 2026-08-04).** The gate's second field lesson: pulls still carry the session identity, and the store used to pin it durably on first sight — so a never-flushed orb that restarted (fresh session id) failed with `session_mismatch` even though nothing had been replicated. Both stores now treat a changed session as legitimate rotation and re-initialize whenever the replication cursor is null; `session_mismatch` remains a strict integrity failure once any record is committed. The FakeWorld models the rotation (an unflushed session evaporates with the runtime process), which turns the `empty-history-restart` DST scenario into the full regression test for the incident shape. The SDK's lazy-flush behavior and id stability across reopen are pinned in `session-flush.contract.test.ts`; the stop-before-first-reply restart shape is covered in lifecycle DST (`empty-history-restart`). Forcing the SDK to flush eagerly was rejected: it requires mutating two private SessionManager members in exactly the right order (`_rewriteFile` plus the `flushed` flag, whose interplay with the SDK's own `wx`-mode flush would otherwise throw) — a public `eagerPersist` option upstream remains the cleaner long-term alternative. The remaining hardening from this incident is tracked in `TODO.md`. The pull model's unknown-cursor rule itself worked as designed: loud `failed`, no silent rewind.
## Minimal PostgreSQL schema

The initial slice used three tables: `projects`, `orbs`, and `history_records`; credential pointers were subsequently added for the broker. Replication state lives on the orb row. Orb deletion in `docs/orb-deletion.md` adds one minimal, short-lived tombstone table to record cleanup and fence stale external operations before history, the orb row, and the tombstone are removed together. Do not add user/auth, live-event, polling-job, generic host-resource, audit, or generic request-claim tables. The send-anytime feature adds one purpose-built `orb_messages` FIFO because stopped-orb acceptance cannot be represented by runtime history that does not yet exist; it must not become a generic job table.

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

Orb naming reuses the `orbs` row rather than adding a job table (`docs/control-plane-api.md`). The nullable name is product state; no source discriminator is needed because generated assignment is conditional on null and later user updates simply replace the name. The lease, attempt count, and next-attempt time are restart-stable coordination for the asynchronous Luna call: a worker claims without holding a database lock across inference, and assignment remains conditional on the name still being null.

Migration `009_orb_messages.sql` adds `orb_messages`, keyed by `(orb_id, message_id)`, with validated JSON content, a database-assigned insertion ordinal, `queued | delivering | delivered | failed` status, optional observed delivery mode/operation ID, sanitized error, timestamps, and an `auto_start` wake bit. The wake bit distinguishes send-after-stop from stop-after-send without adding lifecycle state. Migration `010_message_batches.sql` adds a durable `delivery_batch_id`: claiming the head atomically assigns every currently queued row to that batch, while later arrivals wait for the next one. The replicated native record carries all constituent message IDs as the durable delivery identity; its replication transaction marks all of those rows delivered, and outstanding/status reads remain reload-safe.

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
