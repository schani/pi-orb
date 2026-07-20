import pg from "pg";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";

/**
 * Thin Result-based wrapper over `pg` (DESIGN.md §17.5): explicit
 * BEGIN/COMMIT/ROLLBACK, every driver call caught at this boundary, and no
 * throwing transaction API.
 */

export type PgRow = Record<string, unknown>;

export interface PgQueryResult {
  rows: PgRow[];
  rowCount: number;
}

const CORRUPTION_CODES = new Set([
  "23503", // foreign_key_violation (deferred FKs fire at COMMIT)
  "23505", // unique_violation
  "23514", // check_violation
]);

export function mapPgError(error: unknown): StoreError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (CORRUPTION_CODES.has(code)) {
    return { type: "store_error", code: "corruption", message, retryable: false };
  }
  return { type: "store_error", code: "unavailable", message, retryable: true };
}

export class PgClient {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    // A pool error (idle client dropped) must not crash the process.
    this.pool.on("error", () => undefined);
  }

  query(text: string, values: unknown[] = []): ResultAsync<PgQueryResult, StoreError> {
    return ResultAsync.fromPromise(this.pool.query(text, values), mapPgError).map((result) => ({
      rows: result.rows as PgRow[],
      rowCount: result.rowCount ?? 0,
    }));
  }

  /**
   * Run `f` inside one transaction. `f` returns a Result; an Err (or any
   * driver failure) rolls back, an Ok commits. Rollback never depends on
   * throwing.
   */
  transaction<T, E>(
    f: (
      query: (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
    ) => Promise<Result<T, E>>,
  ): ResultAsync<T, E | StoreError> {
    const run = async (): Promise<Result<T, E | StoreError>> => {
      const clientResult = await ResultAsync.fromPromise(this.pool.connect(), mapPgError);
      if (clientResult.isErr()) return err(clientResult.error);
      const client = clientResult.value;
      const clientQuery = (
        text: string,
        values: unknown[] = [],
      ): ResultAsync<PgQueryResult, StoreError> =>
        ResultAsync.fromPromise(client.query(text, values), mapPgError).map((result) => ({
          rows: result.rows as PgRow[],
          rowCount: result.rowCount ?? 0,
        }));
      const begin = await clientQuery("BEGIN");
      if (begin.isErr()) {
        client.release();
        return err(begin.error);
      }
      const outcome = await ResultAsync.fromPromise(f(clientQuery), mapPgError).andThen((inner) =>
        ResultAsync.fromSafePromise(Promise.resolve(inner)),
      );
      if (outcome.isErr() || outcome.value.isErr()) {
        await clientQuery("ROLLBACK");
        client.release();
        if (outcome.isErr()) return err(outcome.error);
        return outcome.value as Result<T, E>;
      }
      const commit = await clientQuery("COMMIT");
      if (commit.isErr()) {
        await clientQuery("ROLLBACK");
        client.release();
        return err(commit.error);
      }
      client.release();
      return ok(outcome.value.value);
    };
    return new ResultAsync(run());
  }

  end(): ResultAsync<void, StoreError> {
    return ResultAsync.fromPromise(this.pool.end(), mapPgError);
  }
}
