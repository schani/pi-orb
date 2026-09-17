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
export interface OriginalOwnerMigrationInput {
  readonly userId: string;
  readonly identityIssuer: string;
  readonly identitySubject: string;
}
export interface MigrationOptions {
  readonly originalOwner?: OriginalOwnerMigrationInput;
  readonly observe?: MigrationObserver;
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
        if (
          migration.name === "023_owned_projects_and_personal_instructions.sql" ||
          migration.name === "024_user_credential_pointers.sql"
        ) {
          const owner = options.originalOwner;
          const configured = await query(
            `SELECT set_config('pi_orb.original_user_id', $1, true),
                    set_config('pi_orb.original_identity_issuer', $2, true),
                    set_config('pi_orb.original_identity_subject', $3, true)`,
            [owner?.userId ?? "", owner?.identityIssuer ?? "", owner?.identitySubject ?? ""],
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
