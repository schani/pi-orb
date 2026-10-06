import { readFile } from "node:fs/promises";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { PgClient } from "../pg/client.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgDurableAuthority } from "./index.ts";

const postgres = process.env.PI_ORB_DURABLE_PG_TEST_URL;
for (const backend of ["pglite", ...(postgres ? ["postgres"] : [])]) {
  let index = 0;
  const cases = createStorageConformance({
    assertions: {
      ok: (value) => expect(value).toBeTruthy(),
      strictEqual: (actual, expected) => expect(actual).toBe(expected),
      deepEqual: (actual, expected) => expect(actual).toEqual(expected),
      partialDeepEqual: (actual, expected) => expect(actual).toMatchObject(expected as object),
      greaterThan: (actual, expected) => expect(actual).toBeGreaterThan(expected),
      rejects: async (promise, message) => {
        await expect(promise).rejects.toThrow(message);
      },
    },
    withStorage: async (use) => {
      const schema = `durable_conformance_${process.pid}_${++index}`;
      const admin = backend === "postgres" ? new PgClient(postgres!) : undefined;
      let db = new PGliteClient() as import("../pg/client.ts").PostgreSQLClient;
      if (admin) {
        (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
        await db.end();
        const url = new URL(postgres!);
        url.searchParams.set("options", `-c search_path=${schema}`);
        db = new PgClient(url.toString());
      }
      const orb = "00000000-0000-4000-8000-000000000001";
      try {
        (
          await db.query(
            "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
          )
        )._unsafeUnwrap();
        (
          await db.query("INSERT INTO orbs(id) VALUES($1) ON CONFLICT DO NOTHING", [orb])
        )._unsafeUnwrap();
        const migration = await readFile(
          new URL("../pg/migrations/035_durable_authority.sql", import.meta.url),
          "utf8",
        );
        (await db.transaction(async (_query, execute) => execute(migration)))._unsafeUnwrap();
        const authority = new PgDurableAuthority(db, () => 0);
        const owner = (await authority.acquire(orb, "test", 0, 0, 1000))._unsafeUnwrap();
        const storage = (
          await authority.open(owner, { project: async () => ok(undefined) })
        )._unsafeUnwrap();
        try {
          await use(storage);
        } finally {
          await storage.close({} as never);
        }
      } finally {
        (await db.end())._unsafeUnwrap();
        if (admin) {
          (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
          (await admin.end())._unsafeUnwrap();
        }
      }
    },
  });
  // Network PG cases share tables in a dedicated test database and run sequentially.
  for (const entry of cases) it(`${backend}: ${entry.name}`, entry.run);
}
