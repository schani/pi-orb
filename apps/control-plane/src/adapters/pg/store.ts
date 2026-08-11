import type { HarnessSessionMetadata, HistoryRecord, OrbState, StopReason } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type {
  CommitPullError,
  ProjectConflict,
  ReplicationIntegrityError,
  StateConflict,
  StoreError,
} from "../../domain/errors.ts";
import { jsonEqual } from "../../domain/json-equal.ts";
import type { OrbDeletionRow, OrbMessageRow, OrbRow, ProjectRow } from "../../domain/orb.ts";
import type {
  CasTransitionParams,
  CasUpdateFieldsParams,
  CommitPullBatchParams,
  ControlPlaneStore,
  RequestOrbArchiveParams,
  RequestOrbDeletionParams,
} from "../../domain/ports.ts";
import type { PgRow, PostgreSQLClient } from "./client.ts";

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return 0;
}

function mapOrbRow(row: PgRow): OrbRow {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    name: row["name"] === null ? null : String(row["name"]),
    autoNameLeaseUntil:
      row["auto_name_lease_until"] == null ? null : toMs(row["auto_name_lease_until"]),
    autoNameAttempts: Number(row["auto_name_attempts"]),
    autoNameNextAttemptAt:
      row["auto_name_next_attempt_at"] == null ? null : toMs(row["auto_name_next_attempt_at"]),
    state: String(row["state"]) as OrbState,
    stateVersion: Number(row["state_version"]),
    hostKind: String(row["host_kind"]),
    hostRef: row["host_ref"] === null ? null : String(row["host_ref"]),
    checkoutCommit: row["checkout_commit"] === null ? null : String(row["checkout_commit"]),
    harnessSessionId: row["harness_session_id"] === null ? null : String(row["harness_session_id"]),
    harnessSessionHeader: (row["harness_session_header"] ?? null) as HarnessSessionMetadata | null,
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    runtimeTokenHash: row["runtime_token_hash"] === null ? null : String(row["runtime_token_hash"]),
    replicationCursor:
      row["replication_cursor"] === null ? null : String(row["replication_cursor"]),
    replicatedHeadId: row["replicated_head_id"] === null ? null : String(row["replicated_head_id"]),
    lastBusyAt: row["last_busy_at"] == null ? null : toMs(row["last_busy_at"]),
    stopReason: row["stop_reason"] == null ? null : (String(row["stop_reason"]) as StopReason),
    stateChangedAt: toMs(row["state_changed_at"]),
    archivedAt: row["archived_at"] == null ? null : toMs(row["archived_at"]),
    createdAt: toMs(row["created_at"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

function mapMessageRow(row: PgRow): OrbMessageRow {
  return {
    orbId: String(row["orb_id"]),
    messageId: String(row["message_id"]),
    ordinal: Number(row["ordinal"]),
    content: row["content"] as OrbMessageRow["content"],
    status: String(row["status"]) as OrbMessageRow["status"],
    delivery: row["delivery"] == null ? null : (String(row["delivery"]) as "turn" | "steer"),
    operationId: row["operation_id"] == null ? null : String(row["operation_id"]),
    deliveryBatchId: row["delivery_batch_id"] == null ? null : String(row["delivery_batch_id"]),
    autoStart: row["auto_start"] === true,
    wakeStateVersion: row["wake_state_version"] == null ? null : Number(row["wake_state_version"]),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    createdAt: toMs(row["created_at"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

function mapDeletionRow(row: PgRow): OrbDeletionRow {
  return {
    orbId: String(row["orb_id"]),
    hostKind: String(row["host_kind"]),
    kind: String(row["kind"]) as "archive" | "delete",
    requestedAt: toMs(row["requested_at"]),
    cleanupAfter: toMs(row["cleanup_after"]),
    historySealedAt: row["history_sealed_at"] == null ? null : toMs(row["history_sealed_at"]),
    sealedCursor: row["sealed_cursor"] == null ? null : String(row["sealed_cursor"]),
    sealedHeadId: row["sealed_head_id"] == null ? null : String(row["sealed_head_id"]),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

function mapProjectRow(row: PgRow): ProjectRow {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    repositoryUrl: String(row["repository_url"]),
    state: String(row["state"]) as ProjectRow["state"],
    stateVersion: Number(row["state_version"]),
    deletionRequestedAt:
      row["deletion_requested_at"] == null ? null : toMs(row["deletion_requested_at"]),
    deletionInitialOrbCount:
      row["deletion_initial_orb_count"] == null ? null : Number(row["deletion_initial_orb_count"]),
    createdAt: toMs(row["created_at"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

function inboxMessageIds(record: HistoryRecord): string[] {
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return [];
  if (native["type"] !== "custom_message" || native["customType"] !== "pi-orb.user-message") {
    return [];
  }
  const details = native["details"];
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  if (Array.isArray(details["messageIds"])) {
    return details["messageIds"].filter((id): id is string => typeof id === "string");
  }
  return typeof details["messageId"] === "string" ? [details["messageId"]] : [];
}

const stateConflict = (currentState?: OrbState): StateConflict => ({
  type: "state_conflict",
  ...(currentState !== undefined ? { currentState } : {}),
});

/** PostgreSQL `ControlPlaneStore` (docs/history-replication.md/docs/stack.md). */
export class PostgreSQLControlPlaneStore implements ControlPlaneStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  getProject(_task: SimulationTask, projectId: string): ResultAsync<ProjectRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM projects WHERE id = $1", [projectId])
      .map((result) => (result.rows[0] !== undefined ? mapProjectRow(result.rows[0]) : null));
  }

  listProjects(_task: SimulationTask): ResultAsync<ProjectRow[], StoreError> {
    return this.db
      .query("SELECT * FROM projects ORDER BY created_at")
      .map((result) => result.rows.map(mapProjectRow));
  }

  listProjectsInState(
    _task: SimulationTask,
    state: "deleting",
  ): ResultAsync<ProjectRow[], StoreError> {
    return this.db
      .query("SELECT * FROM projects WHERE state = $1 ORDER BY created_at", [state])
      .map((result) => result.rows.map(mapProjectRow));
  }

  insertProject(_task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError> {
    return this.db
      .query(
        `INSERT INTO projects (id, name, repository_url, state, state_version,
           deletion_requested_at, deletion_initial_orb_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          project.id,
          project.name,
          project.repositoryUrl,
          project.state,
          project.stateVersion,
          project.deletionRequestedAt === null ? null : new Date(project.deletionRequestedAt),
          project.deletionInitialOrbCount,
          new Date(project.createdAt),
          new Date(project.updatedAt),
        ],
      )
      .map((result) => mapProjectRow(result.rows[0] ?? {}));
  }

  setProjectName(
    _task: SimulationTask,
    params: { projectId: string; name: string; now: number },
  ): ResultAsync<ProjectRow | null, StoreError> {
    return this.db
      .query(
        `UPDATE projects SET name = $2, updated_at = $3
         WHERE id = $1 AND state = 'active' RETURNING *`,
        [params.projectId, params.name, new Date(params.now)],
      )
      .map((result) => (result.rows[0] === undefined ? null : mapProjectRow(result.rows[0])));
  }

  requestProjectDeletion(
    _task: SimulationTask,
    params: { projectId: string; now: number; cleanupAfter: number },
  ): ResultAsync<
    { project: ProjectRow; orbs: OrbRow[]; newlyRequested: boolean; repaired: number },
    StoreError | ProjectConflict
  > {
    return this.db.transaction<
      { project: ProjectRow; orbs: OrbRow[]; newlyRequested: boolean; repaired: number },
      StoreError | ProjectConflict
    >(async (query) => {
      const locked = await query("SELECT * FROM projects WHERE id = $1 FOR UPDATE", [
        params.projectId,
      ]);
      if (locked.isErr()) return err(locked.error);
      const current = locked.value.rows[0];
      if (current === undefined) {
        return err({ type: "project_conflict" as const, reason: "not_found" as const });
      }
      const newlyRequested = current["state"] === "active";
      let projectRow = current;
      if (newlyRequested) {
        const changed = await query(
          `UPDATE projects SET state = 'deleting', state_version = state_version + 1,
             deletion_requested_at = $2,
             deletion_initial_orb_count = (SELECT count(*) FROM orbs WHERE project_id = $1),
             updated_at = $2 WHERE id = $1 RETURNING *`,
          [params.projectId, new Date(params.now)],
        );
        if (changed.isErr()) return err(changed.error);
        projectRow = changed.value.rows[0] ?? {};
      }
      const repairCount = await query(
        `SELECT count(*)::int AS count FROM orbs o
           LEFT JOIN orb_deletions d ON d.orb_id = o.id
         WHERE o.project_id = $1
           AND (o.state <> 'deleting' OR d.orb_id IS NULL OR d.kind <> 'delete')`,
        [params.projectId],
      );
      if (repairCount.isErr()) return err(repairCount.error);
      const transitioned = await query(
        `UPDATE orbs SET state = 'deleting', state_version = state_version + 1,
           state_changed_at = $2, updated_at = $2, last_error = NULL, stop_reason = NULL,
           auto_name_lease_until = NULL, auto_name_next_attempt_at = NULL
         WHERE project_id = $1 AND state <> 'deleting'`,
        [params.projectId, new Date(params.now)],
      );
      if (transitioned.isErr()) return err(transitioned.error);
      const intents = await query(
        `INSERT INTO orb_deletions
           (orb_id, host_kind, kind, requested_at, cleanup_after, last_error, updated_at)
         SELECT id, host_kind, 'delete', $2, $3, NULL, $2 FROM orbs WHERE project_id = $1
         ON CONFLICT (orb_id) DO UPDATE SET kind = 'delete',
           cleanup_after = CASE WHEN orb_deletions.kind = 'delete'
             THEN orb_deletions.cleanup_after ELSE EXCLUDED.cleanup_after END,
           history_sealed_at = NULL, sealed_cursor = NULL, sealed_head_id = NULL,
           last_error = CASE WHEN orb_deletions.kind = 'delete'
             THEN orb_deletions.last_error ELSE NULL END,
           updated_at = EXCLUDED.updated_at`,
        [params.projectId, new Date(params.now), new Date(params.cleanupAfter)],
      );
      if (intents.isErr()) return err(intents.error);
      const children = await query("SELECT * FROM orbs WHERE project_id = $1 ORDER BY created_at", [
        params.projectId,
      ]);
      if (children.isErr()) return err(children.error);
      return ok({
        project: mapProjectRow(projectRow),
        orbs: children.value.rows.map(mapOrbRow),
        newlyRequested,
        repaired: Number(repairCount.value.rows[0]?.["count"] ?? 0),
      });
    });
  }

  getProjectDeletionProgress(
    _task: SimulationTask,
    projectId: string,
  ): ResultAsync<
    import("../../domain/orb.ts").ProjectDeletionProgress,
    StoreError | ProjectConflict
  > {
    return this.db.transaction<
      import("../../domain/orb.ts").ProjectDeletionProgress,
      StoreError | ProjectConflict
    >(async (query) => {
      const project = await query(
        "SELECT state, deletion_initial_orb_count FROM projects WHERE id = $1",
        [projectId],
      );
      if (project.isErr()) return err(project.error);
      const row = project.value.rows[0];
      if (row === undefined)
        return err({ type: "project_conflict" as const, reason: "not_found" as const });
      if (row["state"] !== "deleting")
        return err({ type: "project_conflict" as const, reason: "concurrent_change" as const });
      const counts = await query(
        `SELECT count(*)::int AS remaining,
           count(*) FILTER (WHERE d.last_error IS NOT NULL)::int AS blocked
         FROM orbs o LEFT JOIN orb_deletions d ON d.orb_id = o.id
         WHERE o.project_id = $1`,
        [projectId],
      );
      if (counts.isErr()) return err(counts.error);
      return ok({
        total: Number(row["deletion_initial_orb_count"] ?? 0),
        remaining: Number(counts.value.rows[0]?.["remaining"] ?? 0),
        blocked: Number(counts.value.rows[0]?.["blocked"] ?? 0),
      });
    });
  }

  finalizeProjectDeletion(
    _task: SimulationTask,
    params: { projectId: string; expectedStateVersion: number },
  ): ResultAsync<void, StoreError | ProjectConflict> {
    return this.db.transaction<void, StoreError | ProjectConflict>(async (query) => {
      const removed = await query(
        `DELETE FROM projects p WHERE p.id = $1 AND p.state = 'deleting'
           AND p.state_version = $2
           AND NOT EXISTS (SELECT 1 FROM orbs WHERE project_id = p.id)
         RETURNING id`,
        [params.projectId, params.expectedStateVersion],
      );
      if (removed.isErr()) return err(removed.error);
      if (removed.value.rowCount === 1) return ok(undefined);
      const current = await query("SELECT state_version FROM projects WHERE id = $1", [
        params.projectId,
      ]);
      if (current.isErr()) return err(current.error);
      if (current.value.rows[0] === undefined) return ok(undefined);
      const children = await query("SELECT 1 FROM orbs WHERE project_id = $1 LIMIT 1", [
        params.projectId,
      ]);
      if (children.isErr()) return err(children.error);
      return err({
        type: "project_conflict" as const,
        reason:
          children.value.rowCount > 0
            ? ("children_remain" as const)
            : ("concurrent_change" as const),
      });
    });
  }

  getOrb(_task: SimulationTask, orbId: string): ResultAsync<OrbRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM orbs WHERE id = $1", [orbId])
      .map((result) => (result.rows[0] !== undefined ? mapOrbRow(result.rows[0]) : null));
  }

  getOrbByRuntimeTokenHash(
    _task: SimulationTask,
    tokenHash: string,
  ): ResultAsync<OrbRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM orbs WHERE runtime_token_hash = $1", [tokenHash])
      .map((result) => (result.rows[0] !== undefined ? mapOrbRow(result.rows[0]) : null));
  }

  listOrbsByProject(_task: SimulationTask, projectId: string): ResultAsync<OrbRow[], StoreError> {
    return this.db
      .query("SELECT * FROM orbs WHERE project_id = $1 ORDER BY created_at", [projectId])
      .map((result) => result.rows.map(mapOrbRow));
  }

  listOrbsInStates(
    _task: SimulationTask,
    states: readonly OrbState[],
  ): ResultAsync<OrbRow[], StoreError> {
    return this.db
      .query("SELECT * FROM orbs WHERE state = ANY($1) ORDER BY created_at", [[...states]])
      .map((result) => result.rows.map(mapOrbRow));
  }

  insertOrb(_task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError | ProjectConflict> {
    return this.db.transaction<OrbRow, StoreError | ProjectConflict>(async (query) => {
      // Shares the parent-row lock used by requestProjectDeletion. Whichever
      // transaction wins decides whether this child is included or rejected.
      const parent = await query("SELECT state FROM projects WHERE id = $1 FOR UPDATE", [
        orb.projectId,
      ]);
      if (parent.isErr()) return err(parent.error);
      const state = parent.value.rows[0]?.["state"];
      if (state === undefined)
        return err({ type: "project_conflict" as const, reason: "not_found" as const });
      if (state !== "active")
        return err({ type: "project_conflict" as const, reason: "deleting" as const });
      const inserted = await query(
        `INSERT INTO orbs (id, project_id, name, auto_name_lease_until, auto_name_attempts,
           auto_name_next_attempt_at, state, state_version, host_kind, host_ref,
           checkout_commit, harness_session_id, harness_session_header, last_error,
           runtime_token_hash, replication_cursor, replicated_head_id, last_busy_at,
           stop_reason, state_changed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [
          orb.id,
          orb.projectId,
          orb.name,
          orb.autoNameLeaseUntil === null ? null : new Date(orb.autoNameLeaseUntil),
          orb.autoNameAttempts,
          orb.autoNameNextAttemptAt === null ? null : new Date(orb.autoNameNextAttemptAt),
          orb.state,
          orb.stateVersion,
          orb.hostKind,
          orb.hostRef,
          orb.checkoutCommit,
          orb.harnessSessionId,
          orb.harnessSessionHeader,
          orb.lastError,
          orb.runtimeTokenHash,
          orb.replicationCursor,
          orb.replicatedHeadId,
          orb.lastBusyAt === null ? null : new Date(orb.lastBusyAt),
          orb.stopReason,
          new Date(orb.stateChangedAt),
          new Date(orb.createdAt),
          new Date(orb.updatedAt),
        ],
      );
      if (inserted.isErr()) return err(inserted.error);
      return ok(mapOrbRow(inserted.value.rows[0] ?? {}));
    });
  }

  setOrbName(
    _task: SimulationTask,
    params: { orbId: string; name: string; now: number; onlyIfNull: boolean },
  ): ResultAsync<OrbRow | null, StoreError> {
    return this.db
      .query(
        `UPDATE orbs SET name = $2, auto_name_lease_until = NULL,
           auto_name_next_attempt_at = NULL, updated_at = $3
         WHERE id = $1 AND state NOT IN ('deleting', 'archiving')
           ${params.onlyIfNull ? "AND name IS NULL" : ""} RETURNING *`,
        [params.orbId, params.name, new Date(params.now)],
      )
      .map((result) => (result.rows[0] === undefined ? null : mapOrbRow(result.rows[0])));
  }

  claimOrbAutoName(
    _task: SimulationTask,
    params: { orbId: string; now: number; leaseUntil: number },
  ): ResultAsync<"claimed" | "already_named" | "in_progress" | "backoff", StoreError> {
    const run = async (): Promise<
      Result<"claimed" | "already_named" | "in_progress" | "backoff", StoreError>
    > => {
      const claimed = await this.db.query(
        `UPDATE orbs SET auto_name_lease_until = $3,
           auto_name_attempts = auto_name_attempts + 1
         WHERE id = $1 AND name IS NULL AND state NOT IN ('deleting', 'archiving', 'archived')
           AND (auto_name_lease_until IS NULL OR auto_name_lease_until <= $2)
           AND (auto_name_next_attempt_at IS NULL OR auto_name_next_attempt_at <= $2)
         RETURNING id`,
        [params.orbId, new Date(params.now), new Date(params.leaseUntil)],
      );
      if (claimed.isErr()) return err(claimed.error);
      if (claimed.value.rows[0] !== undefined) return ok("claimed");
      const current = await this.db.query(
        "SELECT name, auto_name_lease_until, auto_name_next_attempt_at FROM orbs WHERE id = $1",
        [params.orbId],
      );
      if (current.isErr()) return err(current.error);
      const row = current.value.rows[0];
      if (row === undefined || row["name"] !== null) return ok("already_named");
      if (
        row["auto_name_next_attempt_at"] != null &&
        toMs(row["auto_name_next_attempt_at"]) > params.now
      )
        return ok("backoff");
      return ok("in_progress");
    };
    return new ResultAsync(run());
  }

  failOrbAutoName(
    _task: SimulationTask,
    params: { orbId: string; now: number; nextAttemptAt: number },
  ): ResultAsync<void, StoreError> {
    return this.db
      .query(
        `UPDATE orbs SET auto_name_lease_until = NULL, auto_name_next_attempt_at = $2,
           updated_at = $3 WHERE id = $1 AND name IS NULL
             AND state NOT IN ('deleting', 'archiving', 'archived')`,
        [params.orbId, new Date(params.nextAttemptAt), new Date(params.now)],
      )
      .map(() => undefined);
  }

  enqueueOrbMessage(
    _task: SimulationTask,
    params: {
      orbId: string;
      messageId: string;
      content: OrbMessageRow["content"];
      now: number;
    },
  ): ResultAsync<
    { message: OrbMessageRow; orb: OrbRow; duplicate: boolean },
    StoreError | StateConflict
  > {
    return this.db.transaction<
      { message: OrbMessageRow; orb: OrbRow; duplicate: boolean },
      StoreError | StateConflict
    >(async (query) => {
      const locked = await query("SELECT * FROM orbs WHERE id = $1 FOR UPDATE", [params.orbId]);
      if (locked.isErr()) return err(locked.error);
      let orbRow = locked.value.rows[0];
      if (orbRow === undefined) return err(stateConflict());
      const state = String(orbRow["state"]) as OrbState;
      if (state === "deleting" || state === "archiving" || state === "archived") {
        return err(stateConflict(state));
      }
      const existing = await query(
        "SELECT * FROM orb_messages WHERE orb_id = $1 AND message_id = $2",
        [params.orbId, params.messageId],
      );
      if (existing.isErr()) return err(existing.error);
      const existingRow = existing.value.rows[0];
      if (existingRow !== undefined) {
        if (!jsonEqual(existingRow["content"], params.content)) return err(stateConflict(state));
        return ok({ message: mapMessageRow(existingRow), orb: mapOrbRow(orbRow), duplicate: true });
      }
      // Admission records durable content and, when the orb cannot take
      // delivery right now, the wake intent — never a lifecycle transition.
      // The reconciler's terminal backstop owns the one message-driven
      // transition (docs/lifecycle.md, 2026-08-11). `wake_state_version` is
      // the version the intent was admitted against: a `failed` orb wakes only
      // for an intent naming its current failure, so a new send retries once
      // and a stranded intent never does.
      const autoStart = state === "stopping" || state === "stopped" || state === "failed";
      const inserted = await query(
        `INSERT INTO orb_messages
           (orb_id, message_id, content, status, auto_start, wake_state_version,
            created_at, updated_at)
         VALUES ($1,$2,$3,'queued',$4,$5,$6,$6) RETURNING *`,
        [
          params.orbId,
          params.messageId,
          params.content,
          autoStart,
          autoStart ? Number(orbRow["state_version"]) : null,
          new Date(params.now),
        ],
      );
      if (inserted.isErr()) return err(inserted.error);
      // Accepted user work refreshes the idle anchor, so the idle auto-stop
      // cannot win immediately after a message arrives (docs/lifecycle.md).
      const touched = await query(
        `UPDATE orbs SET last_busy_at = CASE WHEN last_busy_at IS NULL OR last_busy_at < $2
           THEN $2 ELSE last_busy_at END, updated_at = $2 WHERE id = $1 RETURNING *`,
        [params.orbId, new Date(params.now)],
      );
      if (touched.isErr()) return err(touched.error);
      orbRow = touched.value.rows[0] ?? orbRow;
      return ok({
        message: mapMessageRow(inserted.value.rows[0] ?? {}),
        orb: mapOrbRow(orbRow),
        duplicate: false,
      });
    });
  }

  listOrbMessages(_task: SimulationTask, orbId: string): ResultAsync<OrbMessageRow[], StoreError> {
    return this.db
      .query("SELECT * FROM orb_messages WHERE orb_id = $1 ORDER BY ordinal", [orbId])
      .map((result) => result.rows.map(mapMessageRow));
  }

  claimNextOrbMessageBatch(
    _task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<OrbMessageRow[], StoreError> {
    return this.db.transaction<OrbMessageRow[], StoreError>(async (query) => {
      const outstanding = await query(
        `SELECT * FROM orb_messages WHERE orb_id = $1
           AND status IN ('queued', 'delivering') ORDER BY ordinal FOR UPDATE`,
        [params.orbId],
      );
      if (outstanding.isErr()) return err(outstanding.error);
      const first = outstanding.value.rows[0];
      if (first === undefined) return ok([]);
      const existingBatch = first["delivery_batch_id"];
      if (existingBatch !== null) {
        return ok(
          outstanding.value.rows
            .filter((row) => row["delivery_batch_id"] === existingBatch)
            .map(mapMessageRow),
        );
      }
      const batchId = String(first["message_id"]);
      const claimed = await query(
        `UPDATE orb_messages SET delivery_batch_id = $2, status = 'delivering', updated_at = $3
         WHERE orb_id = $1 AND status = 'queued' AND delivery_batch_id IS NULL
         RETURNING *`,
        [params.orbId, batchId, new Date(params.now)],
      );
      if (claimed.isErr()) return err(claimed.error);
      return ok(claimed.value.rows.map(mapMessageRow).sort((a, b) => a.ordinal - b.ordinal));
    });
  }

  noteOrbMessageDelivery(
    _task: SimulationTask,
    params: {
      orbId: string;
      messageIds: readonly string[];
      delivery: "turn" | "steer";
      operationId: string;
      now: number;
    },
  ): ResultAsync<void, StoreError> {
    // `delivered` is kept, never downgraded: replication can commit the inbox
    // record before this note lands, and the classification must still stick
    // (docs/runtime-protocol.md).
    return this.db
      .query(
        `UPDATE orb_messages
           SET status = CASE WHEN status = 'delivered' THEN 'delivered' ELSE 'delivering' END,
           delivery = $3, operation_id = $4, auto_start = false, updated_at = $5
         WHERE orb_id = $1 AND message_id = ANY($2::uuid[])
           AND status IN ('queued', 'delivering', 'delivered')`,
        [
          params.orbId,
          params.messageIds,
          params.delivery,
          params.operationId,
          new Date(params.now),
        ],
      )
      .map(() => undefined);
  }

  failOrbMessageBatch(
    _task: SimulationTask,
    params: { orbId: string; messageIds: readonly string[]; lastError: string; now: number },
  ): ResultAsync<void, StoreError> {
    return this.db
      .query(
        `UPDATE orb_messages SET status = 'failed', last_error = $3,
           auto_start = false, updated_at = $4
         WHERE orb_id = $1 AND message_id = ANY($2::uuid[])
           AND status IN ('queued', 'delivering')`,
        [params.orbId, params.messageIds, params.lastError, new Date(params.now)],
      )
      .map(() => undefined);
  }

  clearOrbMessageAutoStart(
    _task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError> {
    return this.db
      .query(
        `UPDATE orb_messages SET auto_start = false, updated_at = $2
         WHERE orb_id = $1 AND auto_start = true AND status IN ('queued', 'delivering')`,
        [params.orbId, new Date(params.now)],
      )
      .map(() => undefined);
  }

  casStartOrbForQueuedMessage(
    _task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow | null, StoreError | StateConflict> {
    return this.db.transaction<OrbRow | null, StoreError | StateConflict>(async (query) => {
      const locked = await query("SELECT state, state_version FROM orbs WHERE id = $1 FOR UPDATE", [
        params.orbId,
      ]);
      if (locked.isErr()) return err(locked.error);
      const orbRow = locked.value.rows[0];
      if (orbRow === undefined) return err(stateConflict());
      const state = String(orbRow["state"]) as OrbState;
      if (
        (state !== "stopped" && state !== "failed") ||
        Number(orbRow["state_version"]) !== params.expectedStateVersion
      ) {
        return err(stateConflict(state));
      }
      // `FOR UPDATE` on the intent rows makes this decision exclusive with the
      // clear an explicit stop performs: whichever commits first wins, and the
      // loser reads the committed answer. A `stopped` orb wakes for any
      // outstanding intent; a `failed` orb only for one admitted against this
      // very failure, and the transition's version bump retires that privilege
      // without a second write (docs/lifecycle.md).
      const intent = await query(
        `SELECT message_id FROM orb_messages
           WHERE orb_id = $1 AND auto_start = true AND status IN ('queued', 'delivering')
             AND ($2::boolean OR wake_state_version = $3::bigint)
           ORDER BY ordinal LIMIT 1 FOR UPDATE`,
        [params.orbId, state === "stopped", params.expectedStateVersion],
      );
      if (intent.isErr()) return err(intent.error);
      if (intent.value.rows[0] === undefined) return ok(null);
      const started = await query(
        `UPDATE orbs SET state = 'starting', state_version = state_version + 1,
           state_changed_at = $3, updated_at = $3, last_error = NULL, stop_reason = NULL
         WHERE id = $1 AND state_version = $2 AND state IN ('stopped', 'failed') RETURNING *`,
        [params.orbId, params.expectedStateVersion, new Date(params.now)],
      );
      if (started.isErr()) return err(started.error);
      const row = started.value.rows[0];
      return row === undefined ? err(stateConflict()) : ok(mapOrbRow(row));
    });
  }

  requestOrbArchive(
    _task: SimulationTask,
    params: RequestOrbArchiveParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.db.transaction<OrbRow, StoreError | StateConflict>(async (query) => {
      const updated = await query(
        `UPDATE orbs SET state = 'archiving', state_version = state_version + 1,
           state_changed_at = $3, updated_at = $3, last_error = NULL, stop_reason = NULL,
           auto_name_lease_until = NULL, auto_name_next_attempt_at = NULL
         WHERE id = $1 AND state_version = $2 RETURNING *`,
        [params.orbId, params.expectedStateVersion, new Date(params.now)],
      );
      if (updated.isErr()) return err(updated.error);
      const row = updated.value.rows[0];
      if (row === undefined) {
        const current = await query("SELECT state FROM orbs WHERE id = $1", [params.orbId]);
        if (current.isErr()) return err(current.error);
        const state = current.value.rows[0]?.["state"];
        return err(stateConflict(typeof state === "string" ? (state as OrbState) : undefined));
      }
      const intent = await query(
        `INSERT INTO orb_deletions
           (orb_id, host_kind, kind, requested_at, cleanup_after, last_error, updated_at)
         VALUES ($1, $2, 'archive', $3, $4, NULL, $3)`,
        [
          params.orbId,
          String(row["host_kind"]),
          new Date(params.now),
          new Date(params.cleanupAfter),
        ],
      );
      if (intent.isErr()) return err(intent.error);
      return ok(mapOrbRow(row));
    });
  }

  sealOrbArchive(
    _task: SimulationTask,
    params: {
      orbId: string;
      expectedStateVersion: number;
      now: number;
      cursor: string | null;
      headId: string | null;
    },
  ): ResultAsync<void, StoreError | StateConflict> {
    return this.db.transaction<void, StoreError | StateConflict>(async (query) => {
      const current = await query(
        "SELECT state, state_version FROM orbs WHERE id = $1 FOR UPDATE",
        [params.orbId],
      );
      if (current.isErr()) return err(current.error);
      const row = current.value.rows[0];
      if (
        row?.["state"] !== "archiving" ||
        Number(row["state_version"]) !== params.expectedStateVersion
      ) {
        return err(
          stateConflict(
            typeof row?.["state"] === "string" ? (row["state"] as OrbState) : undefined,
          ),
        );
      }
      const sealed = await query(
        `UPDATE orb_deletions SET history_sealed_at = $2, sealed_cursor = $3,
           sealed_head_id = $4, last_error = NULL, updated_at = $2
         WHERE orb_id = $1 AND kind = 'archive'`,
        [params.orbId, new Date(params.now), params.cursor, params.headId],
      );
      if (sealed.isErr()) return err(sealed.error);
      if (sealed.value.rowCount !== 1) return err(stateConflict("archiving"));
      return ok(undefined);
    });
  }

  finalizeOrbArchive(
    _task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.db.transaction<OrbRow, StoreError | StateConflict>(async (query) => {
      const updated = await query(
        `UPDATE orbs SET state = 'archived', state_version = state_version + 1,
           state_changed_at = $3, updated_at = $3, archived_at = $3,
           host_ref = NULL, runtime_token_hash = NULL, last_busy_at = NULL,
           stop_reason = NULL, last_error = NULL, auto_name_lease_until = NULL,
           auto_name_next_attempt_at = NULL
         WHERE id = $1 AND state = 'archiving' AND state_version = $2
           AND EXISTS (SELECT 1 FROM orb_deletions d WHERE d.orb_id = $1
             AND d.kind = 'archive' AND d.history_sealed_at IS NOT NULL)
         RETURNING *`,
        [params.orbId, params.expectedStateVersion, new Date(params.now)],
      );
      if (updated.isErr()) return err(updated.error);
      const row = updated.value.rows[0];
      if (row === undefined) return err(stateConflict());
      const removed = await query("DELETE FROM orb_deletions WHERE orb_id = $1", [params.orbId]);
      if (removed.isErr()) return err(removed.error);
      return ok(mapOrbRow(row));
    });
  }

  requestOrbDeletion(
    _task: SimulationTask,
    params: RequestOrbDeletionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.db.transaction<OrbRow, StoreError | StateConflict>(async (query) => {
      const updated = await query(
        `UPDATE orbs SET state = 'deleting', state_version = state_version + 1,
           state_changed_at = $3, updated_at = $3, last_error = NULL, stop_reason = NULL
         WHERE id = $1 AND state_version = $2 RETURNING *`,
        [params.orbId, params.expectedStateVersion, new Date(params.now)],
      );
      if (updated.isErr()) return err(updated.error);
      const row = updated.value.rows[0];
      if (row === undefined) {
        const current = await query("SELECT state FROM orbs WHERE id = $1", [params.orbId]);
        if (current.isErr()) return err(current.error);
        const state = current.value.rows[0]?.["state"];
        return err(stateConflict(typeof state === "string" ? (state as OrbState) : undefined));
      }
      const tombstone = await query(
        `INSERT INTO orb_deletions
           (orb_id, host_kind, kind, requested_at, cleanup_after, last_error, updated_at)
         VALUES ($1, $2, 'delete', $3, $4, NULL, $3)
         ON CONFLICT (orb_id) DO UPDATE SET kind = 'delete', cleanup_after = EXCLUDED.cleanup_after,
           history_sealed_at = NULL, sealed_cursor = NULL, sealed_head_id = NULL,
           last_error = NULL, updated_at = EXCLUDED.updated_at`,
        [
          params.orbId,
          String(row["host_kind"]),
          new Date(params.now),
          new Date(params.cleanupAfter),
        ],
      );
      if (tombstone.isErr()) return err(tombstone.error);
      return ok(mapOrbRow(row));
    });
  }

  getOrbDeletion(
    _task: SimulationTask,
    orbId: string,
  ): ResultAsync<OrbDeletionRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM orb_deletions WHERE orb_id = $1", [orbId])
      .map((result) => (result.rows[0] === undefined ? null : mapDeletionRow(result.rows[0])));
  }

  recordOrbDeletionError(
    _task: SimulationTask,
    params: { orbId: string; message: string | null; now: number },
  ): ResultAsync<void, StoreError> {
    return this.db.transaction<void, StoreError>(async (query) => {
      const deletion = await query(
        "UPDATE orb_deletions SET last_error = $2, updated_at = $3 WHERE orb_id = $1",
        [params.orbId, params.message, new Date(params.now)],
      );
      if (deletion.isErr()) return err(deletion.error);
      const orb = await query(
        "UPDATE orbs SET last_error = $2, updated_at = $3 WHERE id = $1 AND state IN ('deleting', 'archiving')",
        [params.orbId, params.message, new Date(params.now)],
      );
      if (orb.isErr()) return err(orb.error);
      return ok(undefined);
    });
  }

  finalizeOrbDeletion(
    _task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number },
  ): ResultAsync<void, StoreError | StateConflict> {
    return this.db.transaction<void, StoreError | StateConflict>(async (query) => {
      const current = await query(
        "SELECT state, state_version FROM orbs WHERE id = $1 FOR UPDATE",
        [params.orbId],
      );
      if (current.isErr()) return err(current.error);
      const row = current.value.rows[0];
      if (
        row === undefined ||
        row["state"] !== "deleting" ||
        Number(row["state_version"]) !== params.expectedStateVersion
      ) {
        return err(
          stateConflict(
            typeof row?.["state"] === "string" ? (row["state"] as OrbState) : undefined,
          ),
        );
      }
      const cleared = await query(
        "UPDATE orbs SET replication_cursor = NULL, replicated_head_id = NULL WHERE id = $1",
        [params.orbId],
      );
      if (cleared.isErr()) return err(cleared.error);
      const history = await query("DELETE FROM history_records WHERE orb_id = $1", [params.orbId]);
      if (history.isErr()) return err(history.error);
      const orb = await query("DELETE FROM orbs WHERE id = $1", [params.orbId]);
      if (orb.isErr()) return err(orb.error);
      const tombstone = await query("DELETE FROM orb_deletions WHERE orb_id = $1", [params.orbId]);
      if (tombstone.isErr()) return err(tombstone.error);
      return ok(undefined);
    });
  }

  private casUpdate(
    orbId: string,
    expectedStateVersion: number,
    sets: string[],
    values: unknown[],
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    const sql = `UPDATE orbs SET ${sets.join(", ")}
       WHERE id = $1 AND state_version = $2 RETURNING *`;
    const run = async (): Promise<Result<OrbRow, StoreError | StateConflict>> => {
      const result = await this.db.query(sql, [orbId, expectedStateVersion, ...values]);
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      if (row !== undefined) return ok(mapOrbRow(row));
      const current = await this.db.query("SELECT state FROM orbs WHERE id = $1", [orbId]);
      const state = current.isOk() ? current.value.rows[0]?.["state"] : undefined;
      return err(stateConflict(typeof state === "string" ? (state as OrbState) : undefined));
    };
    return new ResultAsync(run());
  }

  casTransition(
    _task: SimulationTask,
    params: CasTransitionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    const now = new Date(params.now);
    const sets = [
      "state = $3",
      "state_version = state_version + 1",
      "state_changed_at = $4",
      "updated_at = $4",
    ];
    const values: unknown[] = [params.toState, now];
    let index = 5;
    if (params.lastError !== undefined) {
      sets.push(`last_error = $${index}`);
      values.push(params.lastError);
      index += 1;
    }
    if (params.hostRef !== undefined) {
      sets.push(`host_ref = $${index}`);
      values.push(params.hostRef);
      index += 1;
    }
    if (params.checkoutCommit !== undefined) {
      sets.push(`checkout_commit = $${index}`);
      values.push(params.checkoutCommit);
      index += 1;
    }
    if (params.stopReason !== undefined) {
      sets.push(`stop_reason = $${index}`);
      values.push(params.stopReason);
      index += 1;
    }
    return this.casUpdate(params.orbId, params.expectedStateVersion, sets, values);
  }

  casUpdateFields(
    _task: SimulationTask,
    params: CasUpdateFieldsParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    const sets = ["state_version = state_version + 1", "updated_at = $3"];
    const values: unknown[] = [new Date(params.now)];
    let index = 4;
    if (params.lastError !== undefined) {
      sets.push(`last_error = $${index}`);
      values.push(params.lastError);
      index += 1;
    }
    if (params.hostRef !== undefined) {
      sets.push(`host_ref = $${index}`);
      values.push(params.hostRef);
      index += 1;
    }
    if (params.checkoutCommit !== undefined) {
      sets.push(`checkout_commit = $${index}`);
      values.push(params.checkoutCommit);
      index += 1;
    }
    if (params.runtimeTokenHash !== undefined) {
      sets.push(`runtime_token_hash = $${index}`);
      values.push(params.runtimeTokenHash);
      index += 1;
    }
    return this.casUpdate(params.orbId, params.expectedStateVersion, sets, values);
  }

  touchLastBusy(
    _task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError> {
    // Monotone and CAS-free (docs/lifecycle.md): GREATEST keeps concurrent touches safe and
    // no state_version bump means lifecycle CAS never conflicts with this.
    return this.db
      .query(
        `UPDATE orbs SET last_busy_at = GREATEST(COALESCE(last_busy_at, to_timestamp(0)), $2),
           updated_at = GREATEST(updated_at, $2)
         WHERE id = $1`,
        [params.orbId, new Date(params.now)],
      )
      .map(() => undefined);
  }

  casReenterState(
    _task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.casUpdate(
      params.orbId,
      params.expectedStateVersion,
      ["state_version = state_version + 1", "state_changed_at = $3", "updated_at = $3"],
      [new Date(params.now)],
    );
  }

  commitPullBatch(
    _task: SimulationTask,
    params: CommitPullBatchParams,
  ): ResultAsync<OrbRow, CommitPullError> {
    return this.db
      .transaction<OrbRow, CommitPullError>(async (query) => {
        // Serialize competing committers on the row; the cursor check below
        // still implements the optimistic CAS semantics.
        const orbResult = await query(
          "SELECT harness_session_id, harness_session_header, replication_cursor FROM orbs WHERE id = $1 FOR UPDATE",
          [params.orbId],
        );
        if (orbResult.isErr()) return err(orbResult.error);
        const orbRow = orbResult.value.rows[0];
        if (orbRow === undefined) {
          return err<OrbRow, ReplicationIntegrityError>({
            type: "replication_integrity",
            reason: "mapping_failure",
            message: `orb ${params.orbId} does not exist`,
          });
        }
        const currentCursor =
          orbRow["replication_cursor"] === null ? null : String(orbRow["replication_cursor"]);
        if (currentCursor !== params.expectedCursor) {
          return err<OrbRow, CommitPullError>({ type: "cursor_conflict" });
        }
        const storedSessionId =
          orbRow["harness_session_id"] === null ? null : String(orbRow["harness_session_id"]);
        let initializeSession = false;
        if (storedSessionId === null) {
          initializeSession = true;
        } else if (
          storedSessionId !== params.session.id ||
          !jsonEqual(orbRow["harness_session_header"], params.session)
        ) {
          if (currentCursor === null) {
            // An empty replica pins nothing (docs/history-replication.md): with no
            // committed cursor a changed session identity is legitimate
            // rotation — a runtime that never flushed starts a fresh session
            // on reboot. Re-initialize instead of failing the orb.
            initializeSession = true;
          } else {
            return err<OrbRow, ReplicationIntegrityError>({
              type: "replication_integrity",
              reason: "session_mismatch",
              message: `stored session ${storedSessionId}, pulled session ${params.session.id}`,
            });
          }
        }
        for (const record of params.records) {
          const inserted = await query(
            `INSERT INTO history_records (orb_id, record_id, parent_id, record)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (orb_id, record_id) DO NOTHING
             RETURNING record_id`,
            [params.orbId, record.id, record.parentId, record],
          );
          if (inserted.isErr()) return err(inserted.error);
          if (inserted.value.rowCount === 0) {
            // Existing row: identical content is an idempotent repeat,
            // different content is an integrity error (docs/history-replication.md).
            const existing = await query(
              "SELECT record FROM history_records WHERE orb_id = $1 AND record_id = $2",
              [params.orbId, record.id],
            );
            if (existing.isErr()) return err(existing.error);
            const stored = existing.value.rows[0]?.["record"];
            if (!jsonEqual(stored, JSON.parse(JSON.stringify(record)))) {
              return err<OrbRow, ReplicationIntegrityError>({
                type: "replication_integrity",
                reason: "record_conflict",
                message: `record ${record.id} already exists with different content`,
              });
            }
          }
        }
        const deliveredMessageIds = params.records.flatMap(inboxMessageIds);
        for (const messageId of deliveredMessageIds) {
          const delivered = await query(
            `UPDATE orb_messages SET status = 'delivered', auto_start = false,
               last_error = NULL, updated_at = now()
             WHERE orb_id = $1 AND message_id = $2`,
            [params.orbId, messageId],
          );
          if (delivered.isErr()) return err(delivered.error);
        }
        const sessionSets = initializeSession
          ? ", harness_session_id = $4, harness_session_header = $5"
          : "";
        const values: unknown[] = [params.orbId, params.nextCursor, params.nextHeadId];
        if (initializeSession) values.push(params.session.id, params.session);
        const updated = await query(
          `UPDATE orbs SET replication_cursor = $2, replicated_head_id = $3,
             updated_at = now()${sessionSets}
           WHERE id = $1 RETURNING *`,
          values,
        );
        if (updated.isErr()) return err(updated.error);
        const row = updated.value.rows[0];
        if (row === undefined) {
          return err<OrbRow, ReplicationIntegrityError>({
            type: "replication_integrity",
            reason: "mapping_failure",
            message: "orb row disappeared during commit",
          });
        }
        return ok(mapOrbRow(row));
      })
      .mapErr((error): CommitPullError => {
        // A deferred FK/check violation at COMMIT means the batch referenced
        // an unknown parent/cursor/head: an integrity failure, not an outage.
        if (error.type === "store_error" && error.code === "corruption") {
          return {
            type: "replication_integrity",
            reason: "mapping_failure",
            message: error.message,
          };
        }
        return error;
      });
  }

  initOrVerifySession(
    _task: SimulationTask,
    orbId: string,
    session: HarnessSessionMetadata,
  ): ResultAsync<void, StoreError | ReplicationIntegrityError> {
    return this.db.transaction<void, StoreError | ReplicationIntegrityError>(async (query) => {
      const orbResult = await query(
        "SELECT harness_session_id, harness_session_header, replication_cursor FROM orbs WHERE id = $1 FOR UPDATE",
        [orbId],
      );
      if (orbResult.isErr()) return err(orbResult.error);
      const row = orbResult.value.rows[0];
      if (row === undefined) return ok(undefined);
      const storedSessionId =
        row["harness_session_id"] === null ? null : String(row["harness_session_id"]);
      const storedCursor =
        row["replication_cursor"] === null ? null : String(row["replication_cursor"]);
      if (
        storedSessionId === null ||
        // An empty replica pins nothing (docs/history-replication.md): with no committed
        // cursor, a changed session identity is legitimate rotation.
        (storedCursor === null &&
          (storedSessionId !== session.id || !jsonEqual(row["harness_session_header"], session)))
      ) {
        const updated = await query(
          "UPDATE orbs SET harness_session_id = $2, harness_session_header = $3 WHERE id = $1",
          [orbId, session.id, session],
        );
        if (updated.isErr()) return err(updated.error);
        return ok(undefined);
      }
      if (storedSessionId !== session.id || !jsonEqual(row["harness_session_header"], session)) {
        return err<void, ReplicationIntegrityError>({
          type: "replication_integrity",
          reason: "session_mismatch",
          message: `stored session ${storedSessionId}, pulled session ${session.id}`,
        });
      }
      return ok(undefined);
    });
  }

  readHistorySnapshot(
    _task: SimulationTask,
    orbId: string,
  ): ResultAsync<
    {
      session: HarnessSessionMetadata | null;
      cursor: string | null;
      headId: string | null;
      records: HistoryRecord[];
    },
    StoreError
  > {
    return this.db.transaction<
      {
        session: HarnessSessionMetadata | null;
        cursor: string | null;
        headId: string | null;
        records: HistoryRecord[];
      },
      StoreError
    >(async (query) => {
      const orbResult = await query(
        "SELECT state, harness_session_header, replication_cursor, replicated_head_id FROM orbs WHERE id = $1",
        [orbId],
      );
      if (orbResult.isErr()) return err(orbResult.error);
      const row = orbResult.value.rows[0];
      if (row === undefined || row["state"] === "deleting") {
        return ok({ session: null, cursor: null, headId: null, records: [] });
      }
      const cursor = row["replication_cursor"] === null ? null : String(row["replication_cursor"]);
      // Linear order is reconstructed by following parent_id from the last
      // committed record (docs/history-replication.md).
      const recordsResult = await query(
        `WITH RECURSIVE chain AS (
           SELECT record_id, parent_id, record, 0 AS depth
             FROM history_records WHERE orb_id = $1 AND record_id = $2
           UNION ALL
           SELECT h.record_id, h.parent_id, h.record, chain.depth + 1
             FROM history_records h
             JOIN chain ON h.record_id = chain.parent_id
            WHERE h.orb_id = $1
         )
         SELECT record FROM chain ORDER BY depth DESC`,
        [orbId, cursor],
      );
      if (recordsResult.isErr()) return err(recordsResult.error);
      return ok({
        session: (row["harness_session_header"] ?? null) as HarnessSessionMetadata | null,
        cursor,
        headId: row["replicated_head_id"] === null ? null : String(row["replicated_head_id"]),
        records:
          cursor === null ? [] : recordsResult.value.rows.map((r) => r["record"] as HistoryRecord),
      });
    });
  }
}
