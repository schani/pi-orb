import type { SimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { User, UserStore, VerifiedUserIdentity } from "../../domain/identity.ts";
import type { PgRow, PostgreSQLClient } from "./client.ts";

function mapUser(row: PgRow): User {
  return { id: String(row["id"]), email: row["email"] === null ? null : String(row["email"]) };
}

export class PostgreSQLUserStore implements UserStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  getUser(_task: SimulationTask, userId: string): ResultAsync<User | null, StoreError> {
    return this.db
      .query("SELECT id, email FROM users WHERE id = $1", [userId])
      .map((result) => (result.rows[0] === undefined ? null : mapUser(result.rows[0])));
  }

  resolveUser(
    _task: SimulationTask,
    identity: VerifiedUserIdentity,
    input: { readonly id: string; readonly now: number },
  ): ResultAsync<User, StoreError> {
    return this.db
      .query(
        `INSERT INTO users (id, identity_issuer, identity_subject, email, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (identity_issuer, identity_subject) DO UPDATE
         SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at
         RETURNING id, email`,
        [input.id, identity.issuer, identity.subject, identity.email, new Date(input.now)],
      )
      .andThen((result) => {
        const row = result.rows[0];
        return row !== undefined
          ? okAsync(mapUser(row))
          : errAsync({
              type: "store_error" as const,
              code: "invariant" as const,
              message: "user upsert returned no row",
              retryable: false,
            });
      });
  }
}
