import { type GitIdentity, validateGitIdentity } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { GitIdentityError, GitIdentityStore } from "../../domain/git-identity.ts";
import type { PgQueryResult, PostgreSQLClient } from "./client.ts";

const unavailable = (error?: StoreError): GitIdentityError => ({
  type: "git_identity_error",
  code: error?.code === "unavailable" ? "unavailable" : "internal",
  message:
    error?.code === "unavailable"
      ? "Git identity unavailable"
      : "Git identity storage is inconsistent",
});

/** No row means an unknown user; stored values must still pass the write contract. */
const identity = (result: PgQueryResult) =>
  validateGitIdentity(result.rows[0] ?? null).mapErr(() => unavailable());

export class PostgreSQLGitIdentityStore implements GitIdentityStore {
  private readonly db: PostgreSQLClient;
  constructor(db: PostgreSQLClient) {
    this.db = db;
  }
  read(_task: SimulationTask, userId: string): ResultAsync<GitIdentity, GitIdentityError> {
    return this.db
      .query(
        `SELECT COALESCE(g.name, '') AS name, COALESCE(g.email, '') AS email
         FROM users u LEFT JOIN git_identities g ON g.user_id = u.id
         WHERE u.id = $1`,
        [userId],
      )
      .mapErr(unavailable)
      .andThen(identity);
  }
  replace(
    _task: SimulationTask,
    userId: string,
    value: GitIdentity,
  ): ResultAsync<GitIdentity, GitIdentityError> {
    return this.db
      .query(
        `INSERT INTO git_identities (user_id, name, email, updated_at)
         SELECT id, $2, $3, now() FROM users WHERE id = $1
         ON CONFLICT (user_id) DO UPDATE
         SET name = EXCLUDED.name, email = EXCLUDED.email, updated_at = now()
         RETURNING name, email`,
        [userId, value.name, value.email],
      )
      .mapErr(unavailable)
      .andThen(identity);
  }
}
