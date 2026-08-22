import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { SigningKeyConflict, StoreError } from "../../domain/errors.ts";
import type {
  CasSigningKeyStateParams,
  SigningKeyRow,
  SigningKeyState,
  SigningKeyStore,
} from "../../domain/ports.ts";
import { jsonParam, type PgRow, type PostgreSQLClient } from "./client.ts";

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return new Date(value).getTime();
  return 0;
}

function mapRow(row: PgRow): SigningKeyRow {
  return {
    kid: String(row["kid"]),
    secretVersion: String(row["secret_version"]),
    publicJwk: row["public_jwk"] ?? null,
    state: String(row["state"]) as SigningKeyState,
    createdAt: toMs(row["created_at"]),
    activatedAt: row["activated_at"] == null ? null : toMs(row["activated_at"]),
    retiredAt: row["retired_at"] == null ? null : toMs(row["retired_at"]),
    rowVersion: Number(row["row_version"]),
  };
}

/**
 * PostgreSQL signing-key store (docs/workload-identity.md): CAS on
 * `row_version`, with the duplicate `kid` and second-active-key violations
 * left to the schema so both clients report them identically.
 */
export class PostgreSQLSigningKeyStore implements SigningKeyStore {
  private readonly db: PostgreSQLClient;

  constructor(db: PostgreSQLClient) {
    this.db = db;
  }

  listSigningKeys(_task: SimulationTask): ResultAsync<SigningKeyRow[], StoreError> {
    return this.db
      .query("SELECT * FROM oidc_signing_keys ORDER BY created_at, kid")
      .map((result) => result.rows.map(mapRow));
  }

  insertSigningKey(
    _task: SimulationTask,
    row: SigningKeyRow,
  ): ResultAsync<SigningKeyRow, StoreError> {
    return this.db
      .query(
        `INSERT INTO oidc_signing_keys
           (kid, secret_version, public_jwk, state, row_version, created_at, activated_at, retired_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          row.kid,
          row.secretVersion,
          jsonParam(row.publicJwk),
          row.state,
          row.rowVersion,
          new Date(row.createdAt),
          row.activatedAt === null ? null : new Date(row.activatedAt),
          row.retiredAt === null ? null : new Date(row.retiredAt),
        ],
      )
      .map((result) => mapRow(result.rows[0] ?? {}));
  }

  casSigningKeyState(
    _task: SimulationTask,
    params: CasSigningKeyStateParams,
  ): ResultAsync<SigningKeyRow, StoreError | SigningKeyConflict> {
    const sets = ["state = $3", "row_version = row_version + 1"];
    const values: unknown[] = [params.kid, params.expectedRowVersion, params.state];
    if (params.activatedAt !== undefined) {
      sets.push(`activated_at = $${values.length + 1}`);
      values.push(new Date(params.activatedAt));
    }
    if (params.retiredAt !== undefined) {
      sets.push(`retired_at = $${values.length + 1}`);
      values.push(new Date(params.retiredAt));
    }
    const run = async (): Promise<Result<SigningKeyRow, StoreError | SigningKeyConflict>> => {
      const result = await this.db.query(
        `UPDATE oidc_signing_keys SET ${sets.join(", ")}
         WHERE kid = $1 AND row_version = $2
         RETURNING *`,
        values,
      );
      if (result.isErr()) return err(result.error);
      const row = result.value.rows[0];
      if (row === undefined) return err({ type: "signing_key_conflict" });
      return ok(mapRow(row));
    };
    return new ResultAsync(run());
  }
}
