import type { SimulationTask } from "determined";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { HarnessSessionMetadata, HistoryRecord, OrbState } from "@pi-orb/protocol";
import type {
  CommitPullError,
  ReplicationIntegrityError,
  StateConflict,
  StoreError,
} from "../../domain/errors.ts";
import type { OrbRow, ProjectRow } from "../../domain/orb.ts";
import type {
  CasTransitionParams,
  CasUpdateFieldsParams,
  CommitPullBatchParams,
  ControlPlaneStore,
} from "../../domain/ports.ts";
import { jsonEqual } from "../../domain/json-equal.ts";
import { PgClient, type PgRow } from "./client.ts";

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return 0;
}

function mapOrbRow(row: PgRow): OrbRow {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    state: String(row["state"]) as OrbState,
    stateVersion: Number(row["state_version"]),
    hostKind: String(row["host_kind"]),
    hostRef: row["host_ref"] === null ? null : String(row["host_ref"]),
    checkoutCommit: row["checkout_commit"] === null ? null : String(row["checkout_commit"]),
    harnessSessionId: row["harness_session_id"] === null ? null : String(row["harness_session_id"]),
    harnessSessionHeader: (row["harness_session_header"] ?? null) as HarnessSessionMetadata | null,
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    replicationCursor:
      row["replication_cursor"] === null ? null : String(row["replication_cursor"]),
    replicatedHeadId: row["replicated_head_id"] === null ? null : String(row["replicated_head_id"]),
    stateChangedAt: toMs(row["state_changed_at"]),
    createdAt: toMs(row["created_at"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

function mapProjectRow(row: PgRow): ProjectRow {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    repositoryUrl: String(row["repository_url"]),
    createdAt: toMs(row["created_at"]),
  };
}

const stateConflict = (currentState?: OrbState): StateConflict => ({
  type: "state_conflict",
  ...(currentState !== undefined ? { currentState } : {}),
});

/** PostgreSQL `ControlPlaneStore` (DESIGN.md §8.6/§17.5). */
export class PgControlPlaneStore implements ControlPlaneStore {
  private readonly db: PgClient;

  constructor(db: PgClient) {
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

  insertProject(_task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError> {
    return this.db
      .query(
        "INSERT INTO projects (id, name, repository_url, created_at) VALUES ($1, $2, $3, $4) RETURNING *",
        [project.id, project.name, project.repositoryUrl, new Date(project.createdAt)],
      )
      .map((result) => mapProjectRow(result.rows[0] ?? {}));
  }

  getOrb(_task: SimulationTask, orbId: string): ResultAsync<OrbRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM orbs WHERE id = $1", [orbId])
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

  insertOrb(_task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError> {
    return this.db
      .query(
        `INSERT INTO orbs (id, project_id, state, state_version, host_kind, host_ref,
           checkout_commit, harness_session_id, harness_session_header, last_error,
           replication_cursor, replicated_head_id, state_changed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          orb.id,
          orb.projectId,
          orb.state,
          orb.stateVersion,
          orb.hostKind,
          orb.hostRef,
          orb.checkoutCommit,
          orb.harnessSessionId,
          orb.harnessSessionHeader,
          orb.lastError,
          orb.replicationCursor,
          orb.replicatedHeadId,
          new Date(orb.stateChangedAt),
          new Date(orb.createdAt),
          new Date(orb.updatedAt),
        ],
      )
      .map((result) => mapOrbRow(result.rows[0] ?? {}));
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
    return this.casUpdate(params.orbId, params.expectedStateVersion, sets, values);
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
          return err<OrbRow, ReplicationIntegrityError>({
            type: "replication_integrity",
            reason: "session_mismatch",
            message: `stored session ${storedSessionId}, pulled session ${params.session.id}`,
          });
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
            // different content is an integrity error (§8.6).
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
        "SELECT harness_session_id, harness_session_header FROM orbs WHERE id = $1 FOR UPDATE",
        [orbId],
      );
      if (orbResult.isErr()) return err(orbResult.error);
      const row = orbResult.value.rows[0];
      if (row === undefined) return ok(undefined);
      const storedSessionId =
        row["harness_session_id"] === null ? null : String(row["harness_session_id"]);
      if (storedSessionId === null) {
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
        "SELECT harness_session_header, replication_cursor, replicated_head_id FROM orbs WHERE id = $1",
        [orbId],
      );
      if (orbResult.isErr()) return err(orbResult.error);
      const row = orbResult.value.rows[0];
      if (row === undefined) {
        return ok({ session: null, cursor: null, headId: null, records: [] });
      }
      const cursor = row["replication_cursor"] === null ? null : String(row["replication_cursor"]);
      // Linear order is reconstructed by following parent_id from the last
      // committed record (DESIGN.md §8.6).
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
