import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { StoreError } from "../domain/errors.ts";
import type {
  ControlPlaneStore,
  CredentialPointerStore,
  ProjectSecretPointerStore,
  SigningKeyStore,
} from "../domain/ports.ts";
import { PgClient, type PostgreSQLClient } from "./pg/client.ts";
import { PostgreSQLCredentialPointerStore } from "./pg/credential-pointers.ts";
import { runMigrations } from "./pg/migrate.ts";
import { PGliteClient } from "./pg/pglite-client.ts";
import { PostgreSQLProjectSecretPointerStore } from "./pg/project-secrets.ts";
import { PostgreSQLSigningKeyStore } from "./pg/signing-keys.ts";
import { PostgreSQLControlPlaneStore } from "./pg/store.ts";

export interface ControlPlaneDatabase {
  readonly store: ControlPlaneStore;
  readonly pointers: CredentialPointerStore;
  readonly projectSecrets: ProjectSecretPointerStore;
  readonly signingKeys: SigningKeyStore;
  migrate(): ResultAsync<string[], StoreError>;
  close(): ResultAsync<void, StoreError>;
}

export type DatabaseOptions =
  | { readonly kind: "postgresql"; readonly connectionString: string }
  | { readonly kind: "pglite"; readonly path?: string };

/** Compose the stores over an already-built client (also the test seam for a raw client). */
export function composeControlPlaneDatabase(client: PostgreSQLClient): ControlPlaneDatabase {
  return {
    store: new PostgreSQLControlPlaneStore(client),
    pointers: new PostgreSQLCredentialPointerStore(client),
    projectSecrets: new PostgreSQLProjectSecretPointerStore(client),
    signingKeys: new PostgreSQLSigningKeyStore(client),
    migrate: () => runMigrations(client),
    close: () => client.end(),
  };
}

export function openControlPlaneDatabase(
  options: DatabaseOptions,
): Result<ControlPlaneDatabase, StoreError> {
  try {
    if (options.kind === "postgresql")
      return ok(composeControlPlaneDatabase(new PgClient(options.connectionString)));
    if (options.path !== undefined)
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    return ok(composeControlPlaneDatabase(new PGliteClient(options.path)));
  } catch (error) {
    return err({
      type: "store_error",
      code: "unavailable",
      message: `cannot initialize ${options.kind}: ${String(error)}`,
      retryable: false,
    });
  }
}
