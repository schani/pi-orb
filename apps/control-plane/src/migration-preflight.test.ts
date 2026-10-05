import { readdirSync } from "node:fs";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { PgRow } from "./adapters/pg/client.ts";
import { PGliteClient } from "./adapters/pg/pglite-client.ts";
import { migrationMode } from "./migrate.ts";
import {
  checkConsolidation,
  compareConsolidation,
  consolidationInput,
  runConsolidationPreflight,
} from "./migration-preflight.ts";

const source = readdirSync(new URL("./adapters/pg/migrations/", import.meta.url))
  .filter((n) => n.endsWith(".sql"))
  .sort();
const applied = source.filter((n) => n !== "031_google_identities.sql");
const mappings = Array.from({ length: 6 }, (_, i) => ({
  userId: `00000000-0000-4000-8000-00000000000${i + 1}`,
  oldIssuer: "https://cloud.google.com/iap",
  oldSubject: `old-${i}`,
  googleSubject: `google-${i}`,
}));
const input = { mappings, primaryUserId: mappings[0]!.userId };
const rows = mappings.map((m) => ({
  id: m.userId,
  identity_issuer: m.oldIssuer,
  identity_subject: m.oldSubject,
}));
const compare = (users: readonly PgRow[] = rows, ledger = applied, files = source, value = input) =>
  compareConsolidation(files, ledger, users, value);

it("rejects unknown arguments without migration fallthrough and emits only safe input failures", async () => {
  expect(migrationMode([])._unsafeUnwrap()).toBe("migrate");
  expect(migrationMode(["--check-consolidation"])._unsafeUnwrap()).toBe("consolidation-preflight");
  expect(migrationMode(["--unknown"]).isErr()).toBe(true);
  expect(migrationMode(["--check-consolidation", "--unknown"]).isErr()).toBe(true);
  const lines: string[] = [];
  expect(
    await runConsolidationPreflight(
      {
        PI_ORB_DATABASE_URL: "private-sentinel",
        PI_ORB_GOOGLE_IDENTITY_MAPPINGS: "private-sentinel",
      },
      (line) => lines.push(line),
      (line) => lines.push(line),
    ),
  ).toBe(1);
  expect(lines).toEqual([JSON.stringify({ kind: "consolidation_preflight", reason: "input" })]);
});

it("accepts only six exact identity tuples and a bound primary UUID", () => {
  expect(compare()._unsafeUnwrap()).toEqual({
    schemaVersion: 1,
    mode: "consolidation-preflight",
    status: "ok",
    pendingMigrations: ["031_google_identities.sql"],
    mappingCount: 6,
    primaryAnchorMatched: true,
  });
  expect(consolidationInput({}).isErr()).toBe(true);
  expect(
    consolidationInput({
      PI_ORB_USER_ID: input.primaryUserId,
      PI_ORB_GOOGLE_IDENTITY_MAPPINGS: JSON.stringify(mappings),
    }).isOk(),
  ).toBe(true);
  expect(compare(rows, applied, source, { ...input, primaryUserId: "bad" }).isErr()).toBe(true);
  expect(
    compare(rows, applied, source, {
      ...input,
      primaryUserId: "00000000-0000-4000-8000-000000000099",
    }).isErr(),
  ).toBe(true);
});
it("rejects tuple drift, even with the same email, extra IAP users and destination collisions", () => {
  expect(
    compare([
      { ...rows[0]!, identity_subject: "drift", email: "same@example.com" },
      ...rows.slice(1),
    ]).isErr(),
  ).toBe(true);
  expect(compare([...rows, { ...rows[0]!, id: "extra", identity_subject: "extra" }]).isErr()).toBe(
    true,
  );
  expect(
    compare([
      ...rows,
      {
        id: "other",
        identity_issuer: "https://accounts.google.com",
        identity_subject: mappings[0]!.googleSubject,
      },
    ]).isErr(),
  ).toBe(true);
  for (const field of ["userId", "googleSubject", "oldSubject"] as const) {
    const duplicate = mappings.map((m, i) =>
      i === 1 ? { ...m, [field]: mappings[0]![field] } : m,
    );
    expect(compare(rows, applied, source, { ...input, mappings: duplicate }).isErr()).toBe(true);
  }
  expect(compare(rows, applied, source, { ...input, mappings: mappings.slice(1) }).isErr()).toBe(
    true,
  );
});
it("requires actual 029 and 030, exactly pending 031, and rejects unknown ledger entries", () => {
  for (const name of ["029_history_record_shape.sql", "030_activity_headlines.sql", applied[0]!])
    expect(
      compare(
        rows,
        applied.filter((n) => n !== name),
      ).isErr(),
    ).toBe(true);
  expect(compare(rows, source).isErr()).toBe(true);
  expect(compare(rows, [...applied, "unknown.sql"]).isErr()).toBe(true);
  expect(compare(rows, applied, [...source, "032_extra.sql"]).isErr()).toBe(true);
  expect(
    compare(rows, [
      ...applied,
      "026_google_identities.sql",
      "027_google_identities.sql",
      "029_google_identities.sql",
    ]).isOk(),
  ).toBe(true);
});
it("always rolls back and never bootstraps or writes, including query failure", async () => {
  for (const fail of [false, true]) {
    const statements: string[] = [];
    const result = await checkConsolidation(
      {
        query: (sql) => {
          statements.push(sql);
          if (fail && sql.includes("schema_migrations"))
            return errAsync({
              type: "store_error",
              code: "unavailable",
              message: "private-sentinel",
              retryable: true,
            });
          return okAsync({
            rows: sql.includes("schema_migrations")
              ? applied.map((name) => ({ name }))
              : sql.includes("FROM users")
                ? rows
                : [],
            rowCount: 0,
          });
        },
      },
      input,
      source,
    );
    expect(result.isOk()).toBe(!fail);
    expect(statements[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.join(" ")).not.toMatch(/CREATE|INSERT|UPDATE|COMMIT|email/);
    expect(JSON.stringify(result)).not.toContain("private-sentinel");
  }
});
describe("PGlite read-only SQL", () => {
  it("reads existing tuples without changes and leaves an empty database empty", async () => {
    const db = new PGliteClient();
    try {
      expect((await checkConsolidation(db, input, source)).isErr()).toBe(true);
      expect(
        (await db.query("SELECT to_regclass('schema_migrations') AS ledger"))._unsafeUnwrap()
          .rows[0]!["ledger"],
      ).toBeNull();
      expect(
        (await db.query("CREATE TABLE schema_migrations (name text PRIMARY KEY)")).isOk(),
      ).toBe(true);
      expect(
        (
          await db.query(
            "CREATE TABLE users (id uuid PRIMARY KEY, identity_issuer text, identity_subject text)",
          )
        ).isOk(),
      ).toBe(true);
      for (const name of applied)
        (await db.query("INSERT INTO schema_migrations VALUES ($1)", [name]))._unsafeUnwrap();
      for (const row of rows)
        (
          await db.query("INSERT INTO users VALUES ($1,$2,$3)", [
            row.id,
            row.identity_issuer,
            row.identity_subject,
          ])
        )._unsafeUnwrap();
      expect((await checkConsolidation(db, input, source)).isOk()).toBe(true);
      expect(
        (
          await db.query("SELECT id, identity_issuer, identity_subject FROM users ORDER BY id")
        )._unsafeUnwrap().rows,
      ).toEqual(rows);
    } finally {
      (await db.end())._unsafeUnwrap();
    }
  });
});
