import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { StoreError } from "../domain/errors.ts";
import type { ControlPlaneStore, CredentialPointerStore } from "../domain/ports.ts";
import { PgClient } from "./pg/client.ts";
import { PostgreSQLCredentialPointerStore } from "./pg/credential-pointers.ts";
import { runMigrations } from "./pg/migrate.ts";
import { PostgreSQLControlPlaneStore } from "./pg/store.ts";
import {
  SqliteControlPlaneStore,
  SqliteCredentialPointerStore,
  SqliteDatabase,
} from "./sqlite/stores.ts";

export interface ControlPlaneDatabase {
  readonly store: ControlPlaneStore;
  readonly pointers: CredentialPointerStore;
  migrate(): ResultAsync<string[], StoreError>;
  close(): ResultAsync<void, StoreError>;
}

export type DatabaseOptions =
  | { readonly kind: "postgresql"; readonly connectionString: string }
  | { readonly kind: "sqlite"; readonly path: string };

function immediate<T>(result: Result<T, StoreError>): ResultAsync<T, StoreError> {
  return new ResultAsync(Promise.resolve(result));
}

export function openControlPlaneDatabase(
  options: DatabaseOptions,
): Result<ControlPlaneDatabase, StoreError> {
  if (options.kind === "postgresql") {
    try {
      const client = new PgClient(options.connectionString);
      return ok({
        store: new PostgreSQLControlPlaneStore(client),
        pointers: new PostgreSQLCredentialPointerStore(client),
        migrate: () => runMigrations(client),
        close: () => client.end(),
      });
    } catch (error) {
      return err({
        type: "store_error",
        code: "unavailable",
        message: `cannot initialize PostgreSQL client: ${String(error)}`,
        retryable: false,
      });
    }
  }
  try {
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return err({
      type: "store_error",
      code: "unavailable",
      message: `cannot create SQLite directory: ${String(error)}`,
      retryable: false,
    });
  }
  const opened = SqliteDatabase.open(options.path);
  if (opened.isErr()) return err(opened.error);
  const database = opened.value;
  return ok({
    store: new SqliteControlPlaneStore(database),
    pointers: new SqliteCredentialPointerStore(database),
    migrate: () => immediate(database.migrate()),
    close: () => immediate(database.close()),
  });
}
