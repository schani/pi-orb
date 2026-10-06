import type { Seq, StorageWrite } from "@earendil-works/pi-durable";
import type { ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { PgQueryResult } from "../pg/client.ts";
import { rejectStorage } from "./storage-boundary.ts";

export type Query = (sql: string, values?: unknown[]) => ResultAsync<PgQueryResult, StoreError>;
export type SqlValue = string | number | null;
export interface SqlExecutor {
  readonly query: Query;
  get<T>(sql: string, ...values: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...values: SqlValue[]): Promise<T[]>;
  run(sql: string, ...values: SqlValue[]): Promise<void>;
}
export interface SqlDatabase extends SqlExecutor {
  mintId(): Promise<number>;
  transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  project(executor: SqlExecutor, writes: readonly StorageWrite[], seq: Seq): Promise<void>;
  close(): Promise<void>;
}

/** Only the fixed, vendored storage SQL crosses this translator. All values stay bound. */
export function scopedSql(sql: string): string {
  let statement = sql;
  const tables =
    "durable_metadata|record_ids|conversations|entries|tasks|submissions|documents|document_revisions";
  if (statement.trimStart().startsWith("SELECT")) {
    statement = statement.replace(
      new RegExp(`FROM (${tables})\\b`, "g"),
      (_, table: string) =>
        `FROM (SELECT * FROM durable_pg_${table} WHERE orb_id = $1) AS ${table}`,
    );
  } else if (statement.trimStart().startsWith("INSERT")) {
    const ignore = statement.includes("INSERT OR IGNORE");
    statement = statement.replace("INSERT OR IGNORE", "INSERT");
    statement = statement.replace(
      new RegExp(`INTO (${tables})\\s+\\(`),
      "INTO durable_pg_$1 (orb_id, ",
    );
    statement = statement.replace("VALUES (", "VALUES ($1, ");
    statement = statement.replace(/ON CONFLICT\(id\)/g, "ON CONFLICT(orb_id, id)");
    if (ignore) statement += " ON CONFLICT DO NOTHING";
  } else if (/^\s*(UPDATE|DELETE)/.test(statement)) {
    statement = statement.replace(new RegExp(`(UPDATE|FROM) (${tables})\\b`), "$1 durable_pg_$2");
    statement = statement.replace("WHERE ", "WHERE orb_id = $1 AND ");
  } else rejectStorage("Unsupported durable SQL operation");
  let parameter = 1;
  return statement.replace(/\?/g, () => `$${++parameter}`);
}

export function executor(query: Query, orbId: string): SqlExecutor {
  const all = async <T>(sql: string, ...values: SqlValue[]): Promise<T[]> => {
    const result = await query(scopedSql(sql), [orbId, ...values]);
    if (result.isErr()) rejectStorage("Durable database operation failed");
    // bigint is textual in pg but numeric in PGlite; normalize only typed SQL numeric columns.
    return result.value.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          ["id", "next_seq", "commit_seq", "seq", "version"].includes(key) ? Number(value) : value,
        ]),
      ),
    ) as T[];
  };
  return {
    query,
    all,
    get: async <T>(sql: string, ...values: SqlValue[]) => (await all<T>(sql, ...values))[0],
    run: async (sql, ...values) => {
      await all(sql, ...values);
    },
  };
}
