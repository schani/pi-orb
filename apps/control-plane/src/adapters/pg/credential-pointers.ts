import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { PointerConflict, StoreError } from "../../domain/errors.ts";
import type {
  CredentialPointerRow,
  CredentialPointerStore,
  CredentialPointerStoreFactory,
  CredentialPointerWrite,
} from "../../domain/ports.ts";
import type { PgRow, PostgreSQLClient } from "./client.ts";

function mapRow(row: PgRow): CredentialPointerRow {
  return {
    provider: String(row["provider"]),
    rowVersion: Number(row["row_version"]),
    generation: Number(row["generation"]),
    secretVersion: row["secret_version"] === null ? null : String(row["secret_version"]),
    refreshLeaseUntil: Number(row["refresh_lease_until"]),
    lastRefreshAt: Number(row["last_refresh_at"]),
  };
}

class BoundPostgreSQLCredentialPointerStore implements CredentialPointerStore {
  private readonly db: PostgreSQLClient;
  private readonly userId: string;

  constructor(db: PostgreSQLClient, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  readPointer(
    _task: SimulationTask,
    provider: string,
  ): ResultAsync<CredentialPointerRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM credential_pointers WHERE user_id = $1 AND provider = $2", [
        this.userId,
        provider,
      ])
      .map((result) => (result.rows[0] !== undefined ? mapRow(result.rows[0]) : null));
  }

  casWritePointer(
    _task: SimulationTask,
    provider: string,
    expectedRowVersion: number | null,
    next: CredentialPointerWrite,
  ): ResultAsync<CredentialPointerRow, StoreError | PointerConflict> {
    const run = async (): Promise<Result<CredentialPointerRow, StoreError | PointerConflict>> => {
      const result =
        expectedRowVersion === null
          ? await this.db.query(
              `INSERT INTO credential_pointers
                 (user_id, provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
               VALUES ($1, $2, 1, $3, $4, $5, $6)
               ON CONFLICT (user_id, provider) DO NOTHING
               RETURNING *`,
              [
                this.userId,
                provider,
                next.generation,
                next.secretVersion,
                next.refreshLeaseUntil,
                next.lastRefreshAt,
              ],
            )
          : await this.db.query(
              `UPDATE credential_pointers
               SET row_version = row_version + 1, generation = $4, secret_version = $5,
                   refresh_lease_until = $6, last_refresh_at = $7
               WHERE user_id = $1 AND provider = $2 AND row_version = $3
               RETURNING *`,
              [
                this.userId,
                provider,
                expectedRowVersion,
                next.generation,
                next.secretVersion,
                next.refreshLeaseUntil,
                next.lastRefreshAt,
              ],
            );
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      if (row === undefined) return err({ type: "pointer_conflict" });
      return ok(mapRow(row));
    };
    return new ResultAsync(run());
  }
}

/** User-bound PostgreSQL credential-pointer adapter. */
export class PostgreSQLCredentialPointerStore implements CredentialPointerStoreFactory {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  forUser(userId: string): CredentialPointerStore {
    return new BoundPostgreSQLCredentialPointerStore(this.db, userId);
  }
}
