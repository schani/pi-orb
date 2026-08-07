import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { HarnessSessionMetadata, HistoryRecord, OrbState, StopReason } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type {
  CommitPullError,
  PointerConflict,
  ReplicationIntegrityError,
  StateConflict,
  StoreError,
} from "../../domain/errors.ts";
import { jsonEqual } from "../../domain/json-equal.ts";
import type { OrbRow, ProjectRow } from "../../domain/orb.ts";
import type {
  CasTransitionParams,
  CasUpdateFieldsParams,
  CommitPullBatchParams,
  ControlPlaneStore,
  CredentialPointerRow,
  CredentialPointerStore,
  CredentialPointerWrite,
} from "../../domain/ports.ts";

export type SqliteRow = Record<string, unknown>;

function sqliteError(error: unknown): StoreError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const corruption =
    code.startsWith("ERR_SQLITE_CONSTRAINT") || code.startsWith("SQLITE_CONSTRAINT");
  return {
    type: "store_error",
    code: corruption ? "corruption" : "unavailable",
    message,
    retryable: !corruption,
  };
}

function asResultAsync<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return new ResultAsync(Promise.resolve(result));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  return JSON.parse(value) as unknown;
}

function mapOrbRow(row: SqliteRow): OrbRow {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    state: String(row["state"]) as OrbState,
    stateVersion: Number(row["state_version"]),
    hostKind: String(row["host_kind"]),
    hostRef: row["host_ref"] === null ? null : String(row["host_ref"]),
    checkoutCommit: row["checkout_commit"] === null ? null : String(row["checkout_commit"]),
    harnessSessionId: row["harness_session_id"] === null ? null : String(row["harness_session_id"]),
    harnessSessionHeader:
      row["harness_session_header"] === null
        ? null
        : (parseJson(row["harness_session_header"]) as HarnessSessionMetadata),
    lastError: row["last_error"] === null ? null : String(row["last_error"]),
    runtimeTokenHash: row["runtime_token_hash"] === null ? null : String(row["runtime_token_hash"]),
    replicationCursor:
      row["replication_cursor"] === null ? null : String(row["replication_cursor"]),
    replicatedHeadId: row["replicated_head_id"] === null ? null : String(row["replicated_head_id"]),
    lastBusyAt: row["last_busy_at"] === null ? null : Number(row["last_busy_at"]),
    stopReason: row["stop_reason"] === null ? null : (String(row["stop_reason"]) as StopReason),
    stateChangedAt: Number(row["state_changed_at"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function mapProjectRow(row: SqliteRow): ProjectRow {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    repositoryUrl: String(row["repository_url"]),
    createdAt: Number(row["created_at"]),
  };
}

function stateConflict(currentState?: OrbState): StateConflict {
  return { type: "state_conflict", ...(currentState === undefined ? {} : { currentState }) };
}

export class SqliteDatabase {
  readonly raw: DatabaseSync;

  private constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  static open(path: string): Result<SqliteDatabase, StoreError> {
    try {
      const raw = new DatabaseSync(path);
      raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      return ok(new SqliteDatabase(raw));
    } catch (error) {
      return err(sqliteError(error));
    }
  }

  migrate(): Result<string[], StoreError> {
    try {
      this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      ) STRICT;`);
      const migrations = [
        {
          name: "001_initial",
          sql: readFileSync(new URL("./migrations/001_initial.sql", import.meta.url), "utf8"),
        },
      ];
      const ran: string[] = [];
      for (const migration of migrations) {
        const existing = this.raw
          .prepare("SELECT name FROM schema_migrations WHERE name = ?")
          .get(migration.name);
        if (existing !== undefined) continue;
        this.raw.exec("BEGIN IMMEDIATE");
        try {
          this.raw.exec(migration.sql);
          this.raw
            .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
            .run(migration.name, Date.now());
          this.raw.exec("COMMIT");
          ran.push(migration.name);
        } catch (error) {
          this.raw.exec("ROLLBACK");
          return err(sqliteError(error));
        }
      }
      return ok(ran);
    } catch (error) {
      return err(sqliteError(error));
    }
  }

  transaction<T, E>(operation: () => Result<T, E>): Result<T, E | StoreError> {
    try {
      this.raw.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON;");
      const result = operation();
      if (result.isErr()) {
        this.raw.exec("ROLLBACK");
        return result;
      }
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // The original typed adapter error is more useful than rollback failure.
      }
      return err(sqliteError(error));
    }
  }

  close(): Result<void, StoreError> {
    try {
      this.raw.close();
      return ok(undefined);
    } catch (error) {
      return err(sqliteError(error));
    }
  }
}

export class SqliteControlPlaneStore implements ControlPlaneStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  private read<T>(operation: () => T): ResultAsync<T, StoreError> {
    try {
      return asResultAsync(ok(operation()));
    } catch (error) {
      return asResultAsync(err(sqliteError(error)));
    }
  }

  getProject(_task: SimulationTask, projectId: string): ResultAsync<ProjectRow | null, StoreError> {
    return this.read(() => {
      const row = this.db.raw.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
        | SqliteRow
        | undefined;
      return row === undefined ? null : mapProjectRow(row);
    });
  }

  listProjects(_task: SimulationTask): ResultAsync<ProjectRow[], StoreError> {
    return this.read(() =>
      (this.db.raw.prepare("SELECT * FROM projects ORDER BY created_at").all() as SqliteRow[]).map(
        mapProjectRow,
      ),
    );
  }

  insertProject(_task: SimulationTask, project: ProjectRow): ResultAsync<ProjectRow, StoreError> {
    return this.read(() => {
      this.db.raw
        .prepare("INSERT INTO projects (id,name,repository_url,created_at) VALUES (?,?,?,?)")
        .run(project.id, project.name, project.repositoryUrl, project.createdAt);
      return project;
    });
  }

  getOrb(_task: SimulationTask, orbId: string): ResultAsync<OrbRow | null, StoreError> {
    return this.read(() => this.getOrbSync(orbId));
  }

  private getOrbSync(orbId: string): OrbRow | null {
    const row = this.db.raw.prepare("SELECT * FROM orbs WHERE id = ?").get(orbId) as
      | SqliteRow
      | undefined;
    return row === undefined ? null : mapOrbRow(row);
  }

  getOrbByRuntimeTokenHash(
    _task: SimulationTask,
    tokenHash: string,
  ): ResultAsync<OrbRow | null, StoreError> {
    return this.read(() => {
      const row = this.db.raw
        .prepare("SELECT * FROM orbs WHERE runtime_token_hash = ?")
        .get(tokenHash) as SqliteRow | undefined;
      return row === undefined ? null : mapOrbRow(row);
    });
  }

  listOrbsByProject(_task: SimulationTask, projectId: string): ResultAsync<OrbRow[], StoreError> {
    return this.read(() =>
      (
        this.db.raw
          .prepare("SELECT * FROM orbs WHERE project_id = ? ORDER BY created_at")
          .all(projectId) as SqliteRow[]
      ).map(mapOrbRow),
    );
  }

  listOrbsInStates(
    _task: SimulationTask,
    states: readonly OrbState[],
  ): ResultAsync<OrbRow[], StoreError> {
    if (states.length === 0) return asResultAsync(ok([]));
    return this.read(() => {
      const placeholders = states.map(() => "?").join(",");
      return (
        this.db.raw
          .prepare(`SELECT * FROM orbs WHERE state IN (${placeholders}) ORDER BY created_at`)
          .all(...states) as SqliteRow[]
      ).map(mapOrbRow);
    });
  }

  insertOrb(_task: SimulationTask, orb: OrbRow): ResultAsync<OrbRow, StoreError> {
    return this.read(() => {
      this.db.raw
        .prepare(`INSERT INTO orbs (
        id,project_id,state,state_version,host_kind,host_ref,checkout_commit,harness_session_id,
        harness_session_header,last_error,runtime_token_hash,replication_cursor,replicated_head_id,
        last_busy_at,stop_reason,state_changed_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...this.orbValues(orb));
      return orb;
    });
  }

  private orbValues(orb: OrbRow): SQLInputValue[] {
    return [
      orb.id,
      orb.projectId,
      orb.state,
      orb.stateVersion,
      orb.hostKind,
      orb.hostRef,
      orb.checkoutCommit,
      orb.harnessSessionId,
      orb.harnessSessionHeader === null ? null : JSON.stringify(orb.harnessSessionHeader),
      orb.lastError,
      orb.runtimeTokenHash,
      orb.replicationCursor,
      orb.replicatedHeadId,
      orb.lastBusyAt,
      orb.stopReason,
      orb.stateChangedAt,
      orb.createdAt,
      orb.updatedAt,
    ];
  }

  private casUpdate(
    orbId: string,
    expectedStateVersion: number,
    sets: string[],
    values: SQLInputValue[],
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    try {
      const changed = this.db.raw
        .prepare(`UPDATE orbs SET ${sets.join(", ")} WHERE id = ? AND state_version = ?`)
        .run(...values, orbId, expectedStateVersion);
      if (changed.changes === 0) {
        const current = this.getOrbSync(orbId);
        return asResultAsync(err(stateConflict(current?.state)));
      }
      const updated = this.getOrbSync(orbId);
      return updated === null
        ? asResultAsync(
            err({
              type: "store_error",
              code: "corruption",
              message: "orb disappeared after CAS",
              retryable: false,
            }),
          )
        : asResultAsync(ok(updated));
    } catch (error) {
      return asResultAsync(err(sqliteError(error)));
    }
  }

  casTransition(
    _task: SimulationTask,
    params: CasTransitionParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    const sets = [
      "state = ?",
      "state_version = state_version + 1",
      "state_changed_at = ?",
      "updated_at = ?",
    ];
    const values: SQLInputValue[] = [params.toState, params.now, params.now];
    const optional: readonly [keyof CasTransitionParams, string][] = [
      ["lastError", "last_error"],
      ["hostRef", "host_ref"],
      ["checkoutCommit", "checkout_commit"],
      ["stopReason", "stop_reason"],
    ];
    for (const [key, column] of optional) {
      const value = params[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value as SQLInputValue);
      }
    }
    return this.casUpdate(params.orbId, params.expectedStateVersion, sets, values);
  }

  casUpdateFields(
    _task: SimulationTask,
    params: CasUpdateFieldsParams,
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    const sets = ["state_version = state_version + 1", "updated_at = ?"];
    const values: SQLInputValue[] = [params.now];
    const optional: readonly [keyof CasUpdateFieldsParams, string][] = [
      ["lastError", "last_error"],
      ["hostRef", "host_ref"],
      ["checkoutCommit", "checkout_commit"],
      ["runtimeTokenHash", "runtime_token_hash"],
    ];
    for (const [key, column] of optional) {
      const value = params[key];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value as SQLInputValue);
      }
    }
    return this.casUpdate(params.orbId, params.expectedStateVersion, sets, values);
  }

  touchLastBusy(
    _task: SimulationTask,
    params: { orbId: string; now: number },
  ): ResultAsync<void, StoreError> {
    return this.read(() => {
      this.db.raw
        .prepare(`UPDATE orbs SET
        last_busy_at = MAX(COALESCE(last_busy_at, 0), ?), updated_at = MAX(updated_at, ?)
        WHERE id = ?`)
        .run(params.now, params.now, params.orbId);
    });
  }

  casReenterState(
    _task: SimulationTask,
    params: { orbId: string; expectedStateVersion: number; now: number },
  ): ResultAsync<OrbRow, StoreError | StateConflict> {
    return this.casUpdate(
      params.orbId,
      params.expectedStateVersion,
      ["state_version = state_version + 1", "state_changed_at = ?", "updated_at = ?"],
      [params.now, params.now],
    );
  }

  commitPullBatch(
    _task: SimulationTask,
    params: CommitPullBatchParams,
  ): ResultAsync<OrbRow, CommitPullError> {
    const result = this.db.transaction<OrbRow, CommitPullError>(() => {
      const orb = this.getOrbSync(params.orbId);
      if (orb === null)
        return err({
          type: "replication_integrity",
          reason: "mapping_failure",
          message: `orb ${params.orbId} does not exist`,
        });
      if (orb.replicationCursor !== params.expectedCursor) return err({ type: "cursor_conflict" });
      let initialize = false;
      if (orb.harnessSessionId === null) initialize = true;
      else if (
        orb.harnessSessionId !== params.session.id ||
        !jsonEqual(orb.harnessSessionHeader, params.session)
      ) {
        if (orb.replicationCursor === null) initialize = true;
        else
          return err({
            type: "replication_integrity",
            reason: "session_mismatch",
            message: `stored session ${orb.harnessSessionId}, pulled session ${params.session.id}`,
          });
      }
      const insert = this.db.raw.prepare(`INSERT INTO history_records
        (orb_id,record_id,parent_id,record,inserted_at) VALUES (?,?,?,?,?)
        ON CONFLICT (orb_id,record_id) DO NOTHING`);
      const select = this.db.raw.prepare(
        "SELECT record FROM history_records WHERE orb_id = ? AND record_id = ?",
      );
      for (const record of params.records) {
        const json = JSON.stringify(record);
        const inserted = insert.run(params.orbId, record.id, record.parentId, json, Date.now());
        if (inserted.changes === 0) {
          const existing = select.get(params.orbId, record.id) as SqliteRow | undefined;
          if (
            existing === undefined ||
            !jsonEqual(parseJson(existing["record"]), JSON.parse(json))
          ) {
            return err({
              type: "replication_integrity",
              reason: "record_conflict",
              message: `record ${record.id} already exists with different content`,
            });
          }
        }
      }
      if (initialize) {
        this.db.raw
          .prepare(`UPDATE orbs SET replication_cursor=?, replicated_head_id=?, updated_at=?,
          harness_session_id=?, harness_session_header=? WHERE id=?`)
          .run(
            params.nextCursor,
            params.nextHeadId,
            Date.now(),
            params.session.id,
            JSON.stringify(params.session),
            params.orbId,
          );
      } else {
        this.db.raw
          .prepare(
            "UPDATE orbs SET replication_cursor=?, replicated_head_id=?, updated_at=? WHERE id=?",
          )
          .run(params.nextCursor, params.nextHeadId, Date.now(), params.orbId);
      }
      const updated = this.getOrbSync(params.orbId);
      return updated === null
        ? err({
            type: "replication_integrity",
            reason: "mapping_failure",
            message: "orb row disappeared during commit",
          })
        : ok(updated);
    });
    if (
      result.isErr() &&
      result.error.type === "store_error" &&
      result.error.code === "corruption"
    ) {
      return asResultAsync(
        err({
          type: "replication_integrity",
          reason: "mapping_failure",
          message: result.error.message,
        }),
      );
    }
    return asResultAsync(result as Result<OrbRow, CommitPullError>);
  }

  initOrVerifySession(
    _task: SimulationTask,
    orbId: string,
    session: HarnessSessionMetadata,
  ): ResultAsync<void, StoreError | ReplicationIntegrityError> {
    return asResultAsync(
      this.db.transaction<void, StoreError | ReplicationIntegrityError>(() => {
        const orb = this.getOrbSync(orbId);
        if (orb === null) return ok(undefined);
        if (
          orb.harnessSessionId === null ||
          (orb.replicationCursor === null &&
            (orb.harnessSessionId !== session.id || !jsonEqual(orb.harnessSessionHeader, session)))
        ) {
          this.db.raw
            .prepare("UPDATE orbs SET harness_session_id=?, harness_session_header=? WHERE id=?")
            .run(session.id, JSON.stringify(session), orbId);
          return ok(undefined);
        }
        if (orb.harnessSessionId !== session.id || !jsonEqual(orb.harnessSessionHeader, session)) {
          return err({
            type: "replication_integrity",
            reason: "session_mismatch",
            message: `stored session ${orb.harnessSessionId}, pulled session ${session.id}`,
          });
        }
        return ok(undefined);
      }),
    );
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
    const result = this.db.transaction<
      {
        session: HarnessSessionMetadata | null;
        cursor: string | null;
        headId: string | null;
        records: HistoryRecord[];
      },
      StoreError
    >(() => {
      const orb = this.getOrbSync(orbId);
      if (orb === null) return ok({ session: null, cursor: null, headId: null, records: [] });
      if (orb.replicationCursor === null)
        return ok({
          session: orb.harnessSessionHeader,
          cursor: null,
          headId: orb.replicatedHeadId,
          records: [],
        });
      const rows = this.db.raw
        .prepare(`WITH RECURSIVE chain(record_id,parent_id,record,depth) AS (
        SELECT record_id,parent_id,record,0 FROM history_records WHERE orb_id=? AND record_id=?
        UNION ALL
        SELECT h.record_id,h.parent_id,h.record,chain.depth+1 FROM history_records h
        JOIN chain ON h.record_id=chain.parent_id WHERE h.orb_id=?
      ) SELECT record FROM chain ORDER BY depth DESC`)
        .all(orbId, orb.replicationCursor, orbId) as SqliteRow[];
      return ok({
        session: orb.harnessSessionHeader,
        cursor: orb.replicationCursor,
        headId: orb.replicatedHeadId,
        records: rows.map((row) => parseJson(row["record"]) as HistoryRecord),
      });
    });
    return asResultAsync(result);
  }
}

function mapPointer(row: SqliteRow): CredentialPointerRow {
  return {
    provider: String(row["provider"]),
    rowVersion: Number(row["row_version"]),
    generation: Number(row["generation"]),
    secretVersion: row["secret_version"] === null ? null : String(row["secret_version"]),
    refreshLeaseUntil: Number(row["refresh_lease_until"]),
    lastRefreshAt: Number(row["last_refresh_at"]),
  };
}

export class SqliteCredentialPointerStore implements CredentialPointerStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  readPointer(
    _task: SimulationTask,
    provider: string,
  ): ResultAsync<CredentialPointerRow | null, StoreError> {
    try {
      const row = this.db.raw
        .prepare("SELECT * FROM credential_pointers WHERE provider=?")
        .get(provider) as SqliteRow | undefined;
      return asResultAsync(ok(row === undefined ? null : mapPointer(row)));
    } catch (error) {
      return asResultAsync(err(sqliteError(error)));
    }
  }

  casWritePointer(
    _task: SimulationTask,
    provider: string,
    expectedRowVersion: number | null,
    next: CredentialPointerWrite,
  ): ResultAsync<CredentialPointerRow, StoreError | PointerConflict> {
    try {
      const result =
        expectedRowVersion === null
          ? this.db.raw
              .prepare(`INSERT INTO credential_pointers
            (provider,row_version,generation,secret_version,refresh_lease_until,last_refresh_at)
            VALUES (?,1,?,?,?,?) ON CONFLICT(provider) DO NOTHING`)
              .run(
                provider,
                next.generation,
                next.secretVersion,
                next.refreshLeaseUntil,
                next.lastRefreshAt,
              )
          : this.db.raw
              .prepare(`UPDATE credential_pointers SET row_version=row_version+1,
            generation=?,secret_version=?,refresh_lease_until=?,last_refresh_at=?
            WHERE provider=? AND row_version=?`)
              .run(
                next.generation,
                next.secretVersion,
                next.refreshLeaseUntil,
                next.lastRefreshAt,
                provider,
                expectedRowVersion,
              );
      if (result.changes === 0) return asResultAsync(err({ type: "pointer_conflict" }));
      const row = this.db.raw
        .prepare("SELECT * FROM credential_pointers WHERE provider=?")
        .get(provider) as SqliteRow;
      return asResultAsync(ok(mapPointer(row)));
    } catch (error) {
      return asResultAsync(err(sqliteError(error)));
    }
  }
}
