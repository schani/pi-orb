import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { StoreError, UserNotFound } from "../../domain/errors.ts";
import type {
  ProjectSecretPointerWrite,
  UserSecretPointerRow,
  UserSecretPointerStore,
} from "../../domain/ports.ts";
import { jsonParam, type PgRow, type PostgreSQLClient } from "./client.ts";

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return Number(value);
}

function mapRow(row: PgRow): UserSecretPointerRow {
  const raw = (row["entries"] ?? {}) as Record<string, unknown>;
  return {
    userId: String(row["user_id"]),
    rowVersion: Number(row["row_version"]),
    revision: Number(row["revision"]),
    entries: Object.fromEntries(Object.entries(raw).map(([name, at]) => [name, Number(at)])),
    secretVersion: String(row["secret_version"]),
    updatedAt: toMs(row["updated_at"]),
  };
}

const userNotFound: UserNotFound = { type: "user_not_found" };

/** Exact-version metadata for owner secrets; users are never deleted, so the only fence is existence. */
export class PostgreSQLUserSecretPointerStore implements UserSecretPointerStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  readUserSecretPointer(
    _task: SimulationTask,
    userId: string,
  ): ResultAsync<UserSecretPointerRow | null, StoreError | UserNotFound> {
    const run = async (): Promise<
      Result<UserSecretPointerRow | null, StoreError | UserNotFound>
    > => {
      const result = await this.db.query(
        `SELECT s.user_id, s.row_version, s.revision, s.entries, s.secret_version, s.updated_at
         FROM users u LEFT JOIN user_secret_pointers s ON s.user_id = u.id
         WHERE u.id = $1`,
        [userId],
      );
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      if (row === undefined) return err(userNotFound);
      return ok(row["user_id"] == null ? null : mapRow(row));
    };
    return new ResultAsync(run());
  }

  casWriteUserSecretPointer(
    _task: SimulationTask,
    userId: string,
    expectedRowVersion: number | null,
    next: ProjectSecretPointerWrite,
  ): ResultAsync<
    UserSecretPointerRow,
    StoreError | UserNotFound | { readonly type: "project_secret_pointer_conflict" }
  > {
    return this.db.transaction<
      UserSecretPointerRow,
      StoreError | UserNotFound | { readonly type: "project_secret_pointer_conflict" }
    >(async (query) => {
      const user = await query("SELECT id FROM users WHERE id = $1 FOR KEY SHARE", [userId]);
      if (user.isErr()) return err(user.error);
      if (user.value.rows[0] === undefined) return err(userNotFound);
      const result =
        expectedRowVersion === null
          ? await query(
              `INSERT INTO user_secret_pointers
                 (user_id, row_version, revision, entries, secret_version, updated_at)
               VALUES ($1, 1, $2, $3, $4, $5)
               ON CONFLICT (user_id) DO NOTHING RETURNING *`,
              [
                userId,
                next.revision,
                jsonParam(next.entries),
                next.secretVersion,
                new Date(next.updatedAt),
              ],
            )
          : await query(
              `UPDATE user_secret_pointers
               SET row_version = row_version + 1, revision = $3, entries = $4,
                   secret_version = $5, updated_at = $6
               WHERE user_id = $1 AND row_version = $2 RETURNING *`,
              [
                userId,
                expectedRowVersion,
                next.revision,
                jsonParam(next.entries),
                next.secretVersion,
                new Date(next.updatedAt),
              ],
            );
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      return row === undefined
        ? err({ type: "project_secret_pointer_conflict" as const })
        : ok(mapRow(row));
    });
  }
}
