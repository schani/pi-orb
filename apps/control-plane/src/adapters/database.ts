import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "../domain/errors.ts";
import type { ControlPlaneStore, CredentialPointerStore } from "../domain/ports.ts";
import { PgClient, type PostgreSQLClient } from "./pg/client.ts";
import { PostgreSQLCredentialPointerStore } from "./pg/credential-pointers.ts";
import { runMigrations } from "./pg/migrate.ts";
import { PGliteClient } from "./pg/pglite-client.ts";
import { PostgreSQLControlPlaneStore } from "./pg/store.ts";

export interface ControlPlaneDatabase {
  readonly store: ControlPlaneStore;
  readonly pointers: CredentialPointerStore;
  migrate(): ResultAsync<string[], StoreError>;
  close(): ResultAsync<void, StoreError>;
}

export type DatabaseOptions =
  | { readonly kind: "postgresql"; readonly connectionString: string }
  | { readonly kind: "pglite"; readonly path?: string };

function compose(client: PostgreSQLClient): ControlPlaneDatabase {
  return {
    store: new PostgreSQLControlPlaneStore(client),
    pointers: new PostgreSQLCredentialPointerStore(client),
    migrate: () => runMigrations(client),
    close: () => client.end(),
  };
}

export function openControlPlaneDatabase(
  options: DatabaseOptions,
): Result<ControlPlaneDatabase, StoreError> {
  try {
    if (options.kind === "postgresql") return ok(compose(new PgClient(options.connectionString)));
    if (options.path !== undefined)
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    return ok(compose(new PGliteClient(options.path)));
  } catch (error) {
    return err({
      type: "store_error",
      code: "unavailable",
      message: `cannot initialize ${options.kind}: ${String(error)}`,
      retryable: false,
    });
  }
}
