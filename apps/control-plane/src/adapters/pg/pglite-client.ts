import { PGlite, type Transaction } from "@electric-sql/pglite";
import { err, type Result, ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import {
  mapPgError,
  type PgQueryResult,
  type PostgreSQLClient,
  withPreparedParams,
} from "./client.ts";

/**
 * Embedded PostgreSQL client for local development and adapter tests.
 *
 * PGlite serializes parameters by the placeholder's OID, so a `jsonParam`
 * value is handed over raw — pre-stringifying it, as the node-postgres client
 * must, would double-encode it (see the parameter-intent note in client.ts).
 */
export class PGliteClient implements PostgreSQLClient {
  private readonly database: PGlite;

  constructor(path?: string) {
    this.database = path === undefined ? new PGlite() : new PGlite(path);
  }

  query(text: string, values: unknown[] = []): ResultAsync<PgQueryResult, StoreError> {
    return withPreparedParams(values, "pglite", (prepared) =>
      ResultAsync.fromPromise(this.database.query(text, prepared), mapPgError).map((result) => ({
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.affectedRows ?? 0,
      })),
    );
  }

  transaction<T, E>(
    f: (
      query: (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
      execute: (text: string) => ResultAsync<void, StoreError>,
    ) => Promise<Result<T, E>>,
  ): ResultAsync<T, E | StoreError> {
    return ResultAsync.fromPromise(
      this.database.transaction(async (transaction) => {
        const execute = (text: string): ResultAsync<void, StoreError> =>
          ResultAsync.fromPromise(transaction.exec(text), mapPgError).map(() => undefined);
        const outcome = await f(this.transactionQuery(transaction), execute);
        if (outcome.isErr()) await transaction.rollback();
        return outcome;
      }),
      mapPgError,
    ).andThen((outcome) => (outcome.isErr() ? err(outcome.error) : outcome));
  }

  end(): ResultAsync<void, StoreError> {
    return ResultAsync.fromPromise(this.database.close(), mapPgError);
  }

  private transactionQuery(
    transaction: Transaction,
  ): (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError> {
    return (text: string, values: unknown[] = []) =>
      withPreparedParams(values, "pglite", (prepared) =>
        ResultAsync.fromPromise(transaction.query(text, prepared), mapPgError).map((result) => ({
          rows: result.rows as Record<string, unknown>[],
          rowCount: result.affectedRows ?? 0,
        })),
      );
  }
}
