import { readdirSync } from "node:fs";
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { PgClient, type PgRow, type PostgreSQLClient } from "./adapters/pg/client.ts";
import type { GoogleIdentityMapping } from "./adapters/pg/migrate.ts";
import { googleIdentityMigrationInput } from "./google-identity-migration-input.ts";

const migration = "031_google_identities.sql";
const iap = "https://cloud.google.com/iap";
const google = "https://accounts.google.com";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const historical = new Set([
  "026_google_identities.sql",
  "027_google_identities.sql",
  "029_google_identities.sql",
]);
export interface PreflightError {
  readonly kind: "consolidation_preflight";
  readonly reason:
    | "arguments"
    | "database_url"
    | "input"
    | "source"
    | "ledger"
    | "mappings"
    | "primary_anchor"
    | "database"
    | "rollback"
    | "close";
}
const failure = (reason: PreflightError["reason"]): PreflightError => ({
  kind: "consolidation_preflight",
  reason,
});
export interface ConsolidationInput {
  readonly mappings: readonly GoogleIdentityMapping[];
  readonly primaryUserId: string;
}
export const consolidationSuccess = {
  schemaVersion: 1,
  mode: "consolidation-preflight",
  status: "ok",
  pendingMigrations: [migration],
  mappingCount: 6,
  primaryAnchorMatched: true,
} as const;

export function consolidationInput(
  env: NodeJS.ProcessEnv,
): ResultType<ConsolidationInput, PreflightError> {
  const parsed = googleIdentityMigrationInput(env);
  const primaryUserId = env["PI_ORB_USER_ID"] ?? "";
  if (
    parsed.isErr() ||
    parsed.value === undefined ||
    parsed.value.length !== 6 ||
    !uuid.test(primaryUserId)
  )
    return err(failure("input"));
  return ok({ mappings: parsed.value, primaryUserId });
}

export function compareConsolidation(
  source: readonly string[],
  applied: readonly string[],
  users: readonly PgRow[],
  input: ConsolidationInput,
): ResultType<typeof consolidationSuccess, PreflightError> {
  const ledger = new Set(applied);
  const pending = source.filter((name) => !ledger.has(name));
  if (
    !ledger.has("029_history_record_shape.sql") ||
    !ledger.has("030_activity_headlines.sql") ||
    ledger.has(migration) ||
    pending.length !== 1 ||
    pending[0] !== migration ||
    applied.some((name) => !source.includes(name) && !historical.has(name))
  )
    return err(failure("ledger"));
  const parsed = consolidationInput({
    PI_ORB_USER_ID: input.primaryUserId,
    PI_ORB_GOOGLE_IDENTITY_MAPPINGS: JSON.stringify(input.mappings),
  });
  if (parsed.isErr()) return err(parsed.error);
  const mappings = input.mappings;
  if (
    new Set(mappings.map((m) => m.userId.toLowerCase())).size !== 6 ||
    new Set(mappings.map((m) => m.googleSubject)).size !== 6 ||
    new Set(mappings.map((m) => m.oldSubject)).size !== 6
  )
    return err(failure("mappings"));
  const legacy = users.filter((u) => u["identity_issuer"] === iap);
  if (
    legacy.length !== 6 ||
    mappings.some(
      (m) =>
        !legacy.some(
          (u) =>
            String(u["id"]).toLowerCase() === m.userId.toLowerCase() &&
            u["identity_issuer"] === m.oldIssuer &&
            u["identity_subject"] === m.oldSubject,
        ),
    ) ||
    mappings.some((m) =>
      users.some(
        (u) => u["identity_issuer"] === google && u["identity_subject"] === m.googleSubject,
      ),
    )
  )
    return err(failure("mappings"));
  if (!mappings.some((m) => m.userId.toLowerCase() === input.primaryUserId.toLowerCase()))
    return err(failure("primary_anchor"));
  return ok(consolidationSuccess);
}

const readSource = Result.fromThrowable(
  () =>
    readdirSync(new URL("./adapters/pg/migrations/", import.meta.url))
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  () => failure("source"),
);

/** A dedicated single-connection client is required; never run the migration runner here. */
export async function checkConsolidation(
  db: Pick<PostgreSQLClient, "query">,
  input: ConsolidationInput,
  source?: readonly string[],
): Promise<ResultType<typeof consolidationSuccess, PreflightError>> {
  const files = source === undefined ? readSource() : ok(source);
  if (files.isErr()) return err(files.error);
  const begun = await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  if (begun.isErr()) return err(failure("database"));
  const ledger = await db.query("SELECT name FROM schema_migrations");
  let outcome: ResultType<typeof consolidationSuccess, PreflightError> = err(failure("database"));
  if (ledger.isOk()) {
    const users = await db.query(
      "SELECT id, identity_issuer, identity_subject FROM users WHERE identity_issuer IN ('https://cloud.google.com/iap', 'https://accounts.google.com')",
    );
    if (users.isOk())
      outcome = compareConsolidation(
        files.value,
        ledger.value.rows.map((row) => String(row["name"])),
        users.value.rows,
        input,
      );
  }
  const rolledBack = await db.query("ROLLBACK");
  return rolledBack.isErr() ? err(failure("rollback")) : outcome;
}

const open = Result.fromThrowable(
  (url: string) => new PgClient(url, true),
  () => failure("database"),
);
/** Source-container CLI: node apps/control-plane/src/migrate.ts --check-consolidation. */
export async function runConsolidationPreflight(
  env: NodeJS.ProcessEnv,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const url = env["DATABASE_URL"];
  const input = consolidationInput(env);
  if (!url) {
    stderr(JSON.stringify(failure("database_url")));
    return 1;
  }
  if (input.isErr()) {
    stderr(JSON.stringify(input.error));
    return 1;
  }
  const opened = open(url);
  if (opened.isErr()) {
    stderr(JSON.stringify(opened.error));
    return 1;
  }
  const result = await checkConsolidation(opened.value, input.value);
  const closed = await opened.value.end();
  if (result.isErr() || closed.isErr()) {
    stderr(JSON.stringify(result.isErr() ? result.error : failure("close")));
    return 1;
  }
  stdout(JSON.stringify(result.value));
  return 0;
}
