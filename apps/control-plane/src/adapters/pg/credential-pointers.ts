import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { PointerConflict, StoreError } from "../../domain/errors.ts";
import type {
  CredentialPointerRow,
  CredentialPointerStore,
  CredentialPointerWrite,
} from "../../domain/ports.ts";
import type { PgClient, PgRow } from "./client.ts";

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

/** PostgreSQL credential-pointer store (DESIGN.md §15.1): CAS on `row_version`. */
export class PgCredentialPointerStore implements CredentialPointerStore {
  private readonly db: PgClient;

  constructor(db: PgClient) {
    this.db = db;
  }

  readPointer(
    _task: SimulationTask,
    provider: string,
  ): ResultAsync<CredentialPointerRow | null, StoreError> {
    return this.db
      .query("SELECT * FROM credential_pointers WHERE provider = $1", [provider])
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
                 (provider, row_version, generation, secret_version, refresh_lease_until, last_refresh_at)
               VALUES ($1, 1, $2, $3, $4, $5)
               ON CONFLICT (provider) DO NOTHING
               RETURNING *`,
              [
                provider,
                next.generation,
                next.secretVersion,
                next.refreshLeaseUntil,
                next.lastRefreshAt,
              ],
            )
          : await this.db.query(
              `UPDATE credential_pointers
               SET row_version = row_version + 1, generation = $3, secret_version = $4,
                   refresh_lease_until = $5, last_refresh_at = $6
               WHERE provider = $1 AND row_version = $2
               RETURNING *`,
              [
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
