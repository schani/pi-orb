import type { Storage } from "@earendil-works/pi-durable";
import { executor, type Query, type SqlDatabase } from "./executor.ts";
import { PgStorage } from "./storage.ts";
import { rejectStorage } from "./storage-boundary.ts";

/** Read your native writes inside the caller's publication transaction; never opens a Harness. */
export function readTransactionStorage(query: Query, orbId: string): Promise<Storage> {
  const reject = async (): Promise<never> => {
    rejectStorage("Transaction reader is read-only");
  };
  const sql = { ...executor(query, orbId), run: reject };
  const db: SqlDatabase = {
    ...sql,
    mintId: reject,
    transaction: (callback) => callback(sql),
    project: reject,
    close: async () => undefined,
  };
  return PgStorage.open(db);
}
