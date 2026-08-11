import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow";
import pg from "pg";
import type { StoreError } from "../../domain/errors.ts";

/**
 * Thin Result-based wrapper over `pg` (docs/stack.md): explicit
 * BEGIN/COMMIT/ROLLBACK, every driver call caught at this boundary, and no
 * throwing transaction API.
 */

export type PgRow = Record<string, unknown>;

export interface PgQueryResult {
  rows: PgRow[];
  rowCount: number;
}

/** Query surface shared by network PostgreSQL and embedded PGlite. */
export interface PostgreSQLClient {
  query(text: string, values?: unknown[]): ResultAsync<PgQueryResult, StoreError>;
  transaction<T, E>(
    f: (
      query: (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
      execute: (text: string) => ResultAsync<void, StoreError>,
    ) => Promise<Result<T, E>>,
  ): ResultAsync<T, E | StoreError>;
  end(): ResultAsync<void, StoreError>;
}

const CORRUPTION_CODES = new Set([
  "23503", // foreign_key_violation (deferred FKs fire at COMMIT)
  "23505", // unique_violation
  "23514", // check_violation
]);

/**
 * SQLSTATE classes that can only mean a bug in our own SQL or parameters:
 * `22` data exception (a value the column type cannot parse, e.g. a JS array
 * bound to a `jsonb` column) and `42` syntax error / undefined object (a
 * column or table the code expects and the schema does not have). Retrying
 * either produces the identical failure forever, so they must not be dressed
 * up as an outage (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).
 */
const INVARIANT_CLASSES = new Set(["22", "42"]);

export function mapPgError(error: unknown): StoreError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (CORRUPTION_CODES.has(code)) {
    return { type: "store_error", code: "corruption", message, retryable: false };
  }
  if (INVARIANT_CLASSES.has(code.slice(0, 2))) {
    return { type: "store_error", code: "invariant", message, retryable: false };
  }
  return { type: "store_error", code: "unavailable", message, retryable: true };
}

// ---------------------------------------------------------------------------
// Explicit parameter intent
//
// The two drivers this code runs on disagree about how to serialize a
// structured query parameter, and the disagreement is silent:
//
//   * node-postgres decides from the JavaScript *value*. A JS array becomes a
//     PostgreSQL array literal (`{...}`) and a plain object becomes JSON. A
//     content array bound to a `jsonb` column therefore fails with SQLSTATE
//     22P02 `invalid input syntax for type json`.
//   * PGlite decides from the parameter *OID* the server reports for that
//     placeholder, so it encodes the same array correctly for a `jsonb`
//     column — and would double-encode an already-stringified value.
//
// So the value alone cannot express the author's intent. `jsonParam()` and
// `arrayParam()` state it, each client unwraps them for its own driver, and
// `prepareParams` rejects any remaining bare array or plain object before the
// driver sees it: the hazard fails identically under PGlite, in the in-memory
// tests, and on real PostgreSQL instead of only in production
// (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md).

/** A value destined for a `json`/`jsonb` column. */
export class JsonParam {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/** A value destined for a PostgreSQL array (`= ANY($1)`, `$1::uuid[]`). */
export class SqlArrayParam {
  readonly values: readonly unknown[];
  constructor(values: readonly unknown[]) {
    this.values = values;
  }
}

/** Bind `value` as `json`/`jsonb`. `null`/`undefined` bind as SQL NULL. */
export const jsonParam = (value: unknown): JsonParam => new JsonParam(value);

/** Bind `values` as a PostgreSQL array. */
export const arrayParam = (values: readonly unknown[]): SqlArrayParam => new SqlArrayParam(values);

/** Which driver a prepared parameter list is destined for. */
export type ParamDriver = "node-postgres" | "pglite";

/** A bare `{}`-literal object (or `Object.create(null)`), not a `Date`/`Buffer`/class instance. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function bareParamError(index: number, kind: "array" | "object"): StoreError {
  return {
    type: "store_error",
    code: "invariant",
    message:
      `parameter $${index + 1} is a bare JavaScript ${kind}: the pg and PGlite drivers encode it ` +
      "differently, so wrap it with jsonParam() for a json/jsonb column or arrayParam() for a " +
      "PostgreSQL array (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md)",
    retryable: false,
  };
}

/**
 * Unwrap the intent wrappers for `driver` and refuse any structured value that
 * did not declare one. Runs before every driver call, in both clients.
 */
export function prepareParams(
  values: readonly unknown[],
  driver: ParamDriver,
): Result<unknown[], StoreError> {
  const prepared: unknown[] = [];
  for (const [index, value] of values.entries()) {
    if (value instanceof JsonParam) {
      // A JSON `null` is not a SQL NULL: `JSON.stringify(null)` would store
      // `null`::jsonb in a nullable column, where `IS NULL` is false.
      if (value.value === null || value.value === undefined) {
        prepared.push(null);
        continue;
      }
      prepared.push(driver === "node-postgres" ? JSON.stringify(value.value) : value.value);
      continue;
    }
    if (value instanceof SqlArrayParam) {
      prepared.push([...value.values]);
      continue;
    }
    if (Array.isArray(value)) return err(bareParamError(index, "array"));
    if (typeof value === "object" && value !== null && isPlainObject(value)) {
      return err(bareParamError(index, "object"));
    }
    prepared.push(value);
  }
  return ok(prepared);
}

/** Prepare `values` for `driver`, or short-circuit the query with the guard error. */
export function withPreparedParams(
  values: readonly unknown[],
  driver: ParamDriver,
  run: (prepared: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
): ResultAsync<PgQueryResult, StoreError> {
  const prepared = prepareParams(values, driver);
  return prepared.isErr() ? errAsync(prepared.error) : run(prepared.value);
}

export class PgClient implements PostgreSQLClient {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    // A pool error (idle client dropped) must not crash the process.
    this.pool.on("error", () => undefined);
  }

  query(text: string, values: unknown[] = []): ResultAsync<PgQueryResult, StoreError> {
    return withPreparedParams(values, "node-postgres", (prepared) =>
      ResultAsync.fromPromise(this.pool.query(text, prepared), mapPgError).map((result) => ({
        rows: result.rows as PgRow[],
        rowCount: result.rowCount ?? 0,
      })),
    );
  }

  /**
   * Run `f` inside one transaction. `f` returns a Result; an Err (or any
   * driver failure) rolls back, an Ok commits. Rollback never depends on
   * throwing.
   */
  transaction<T, E>(
    f: (
      query: (text: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>,
      execute: (text: string) => ResultAsync<void, StoreError>,
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
        withPreparedParams(values, "node-postgres", (prepared) =>
          ResultAsync.fromPromise(client.query(text, prepared), mapPgError).map((result) => ({
            rows: result.rows as PgRow[],
            rowCount: result.rowCount ?? 0,
          })),
        );
      const begin = await clientQuery("BEGIN");
      if (begin.isErr()) {
        client.release();
        return err(begin.error);
      }
      const execute = (text: string): ResultAsync<void, StoreError> =>
        clientQuery(text).map(() => undefined);
      const outcome = await ResultAsync.fromPromise(f(clientQuery, execute), mapPgError).andThen(
        (inner) => ResultAsync.fromSafePromise(Promise.resolve(inner)),
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
