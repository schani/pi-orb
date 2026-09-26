import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { PostgreSQLClient } from "./client.ts";

const readMigrations = Result.fromThrowable(
  (dir: string) => {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
  },
  (error): StoreError => ({
    type: "store_error",
    code: "unavailable",
    message: `cannot read migrations: ${String(error)}`,
    retryable: false,
  }),
);

/** Numbered hand-written SQL migrations with a tiny runner (docs/stack.md). */
export type MigrationObserver = (name: string, stage: "started" | "applied") => void;
export type MigrationOwnerResolutionObserver = (
  source: "users",
  outcome: "resolved" | "unknown" | "not_provided",
) => void;
export interface OriginalOwnerMigrationInput {
  readonly userId: string;
  readonly identityIssuer: string;
  readonly identitySubject: string;
}
export interface GoogleIdentityMapping {
  readonly userId: string;
  readonly oldIssuer: string;
  readonly oldSubject: string;
  readonly googleSubject: string;
}
export interface MigrationOptions {
  readonly googleIdentityMappings?: readonly GoogleIdentityMapping[];
  readonly originalOwner?: OriginalOwnerMigrationInput;
  readonly credentialOwnerUserId?: string;
  readonly observe?: MigrationObserver;
  readonly observeOwnerResolution?: MigrationOwnerResolutionObserver;
}

export function runMigrations(
  db: PostgreSQLClient,
  options: MigrationOptions = {},
): ResultAsync<string[], StoreError> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const run = async (): Promise<Result<string[], StoreError>> => {
    const migrations = readMigrations(dir);
    if (migrations.isErr()) return err(migrations.error);
    const ensure = await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    if (ensure.isErr()) return err(ensure.error);
    const appliedResult = await db.query("SELECT name FROM schema_migrations");
    if (appliedResult.isErr()) return err(appliedResult.error);
    const applied = new Set(appliedResult.value.rows.map((row) => String(row["name"])));
    const ran: string[] = [];
    for (const migration of migrations.value) {
      if (applied.has(migration.name)) continue;
      options.observe?.(migration.name, "started");
      const outcome = await db.transaction<void, StoreError>(async (query, execute) => {
        let owner = options.originalOwner;
        if (migration.name === "024_user_credential_pointers.sql") {
          const selectedUserId = options.credentialOwnerUserId;
          if (selectedUserId === undefined) {
            options.observeOwnerResolution?.("users", "not_provided");
            owner = undefined;
          } else {
            const selected = await query(
              "SELECT id, identity_issuer, identity_subject FROM users WHERE id = $1",
              [selectedUserId],
            );
            if (selected.isErr()) return err(selected.error);
            const row = selected.value.rows[0];
            if (row === undefined) {
              options.observeOwnerResolution?.("users", "unknown");
              return err({
                type: "store_error",
                code: "invariant",
                message: "selected credential owner is not a known user",
                retryable: false,
              });
            }
            owner = {
              userId: String(row["id"]),
              identityIssuer: String(row["identity_issuer"]),
              identitySubject: String(row["identity_subject"]),
            };
            options.observeOwnerResolution?.("users", "resolved");
          }
        }
        if (
          migration.name === "023_owned_projects_and_personal_instructions.sql" ||
          migration.name === "024_user_credential_pointers.sql"
        ) {
          const configured = await query(
            `SELECT set_config('pi_orb.original_user_id', $1, true),
                    set_config('pi_orb.original_identity_issuer', $2, true),
                    set_config('pi_orb.original_identity_subject', $3, true)`,
            [owner?.userId ?? "", owner?.identityIssuer ?? "", owner?.identitySubject ?? ""],
          );
          if (configured.isErr()) return err(configured.error);
        }
        if (migration.name === "027_google_identities.sql") {
          const configured = await query(
            "SELECT set_config('pi_orb.google_identity_mappings', $1, true)",
            [JSON.stringify(options.googleIdentityMappings ?? [])],
          );
          if (configured.isErr()) return err(configured.error);
        }
        const executed = await execute(migration.sql);
        if (executed.isErr()) return err(executed.error);
        const recorded = await query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          migration.name,
        ]);
        if (recorded.isErr()) return err(recorded.error);
        return ok(undefined);
      });
      if (outcome.isErr()) return err(outcome.error);
      ran.push(migration.name);
      options.observe?.(migration.name, "applied");
    }
    return ok(ran);
  };
  return new ResultAsync(run());
}
