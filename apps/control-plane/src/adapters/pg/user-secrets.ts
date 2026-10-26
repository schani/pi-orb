import type { SimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { ProjectSecretPointerConflict, StoreError } from "../../domain/errors.ts";
import type { ProjectSecretPointerRow, ProjectSecretPointerWrite } from "../../domain/ports.ts";
import { jsonParam, type PostgreSQLClient } from "./client.ts";
import { mapRow } from "./project-secrets.ts";

/** Owner-secret pointers; users are never deleted, so there is no fence beyond the FK. */
export class PostgreSQLUserSecretPointerStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  readSecretPointer(
    _task: SimulationTask,
    userId: string,
  ): ResultAsync<ProjectSecretPointerRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM user_secret_pointers WHERE user_id = $1", [userId])
      .map(({ rows }) => (rows[0] === undefined ? null : mapRow(rows[0])));
  }

  casWriteSecretPointer(
    _task: SimulationTask,
    userId: string,
    expectedRowVersion: number | null,
    next: ProjectSecretPointerWrite,
  ): ResultAsync<ProjectSecretPointerRow, StoreError | ProjectSecretPointerConflict> {
    const values = [
      userId,
      next.revision,
      jsonParam(next.entries),
      next.secretVersion,
      new Date(next.updatedAt),
    ];
    const written =
      expectedRowVersion === null
        ? this.db.query(
            `INSERT INTO user_secret_pointers
               (user_id, row_version, revision, entries, secret_version, updated_at)
             VALUES ($1, 1, $2, $3, $4, $5) ON CONFLICT (user_id) DO NOTHING RETURNING *`,
            values,
          )
        : this.db.query(
            `UPDATE user_secret_pointers
             SET row_version = row_version + 1, revision = $2, entries = $3,
                 secret_version = $4, updated_at = $5
             WHERE user_id = $1 AND row_version = $6 RETURNING *`,
            [...values, expectedRowVersion],
          );
    return written.andThen(({ rows }) =>
      rows[0] === undefined
        ? errAsync({ type: "project_secret_pointer_conflict" as const })
        : okAsync(mapRow(rows[0])),
    );
  }
}
