import type { Seq, StorageWrite, SubmissionId } from "@earendil-works/pi-durable";
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
  project(
    executor: SqlExecutor,
    writes: readonly StorageWrite[],
    seq: Seq,
    admittedSubmissions: ReadonlySet<SubmissionId>,
  ): Promise<void>;
  close(): Promise<void>;
}

export function executor(query: Query, orbId: string): SqlExecutor {
  const all = async <T>(sql: string, ...values: SqlValue[]): Promise<T[]> => {
    const result = await query(sql, [orbId, ...values]);
    if (result.isErr()) rejectStorage("Durable database operation failed", { cause: result.error });
    // bigint is textual in pg but numeric in PGlite; normalize only the listed bigint columns.
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
