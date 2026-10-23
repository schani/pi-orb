import { readFile } from "node:fs/promises";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { ok } from "neverthrow";
import { expect, it, onTestFinished } from "vitest";
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
      if (admin) {
        onTestFinished(async () => {
          (await admin.end())._unsafeUnwrap();
        });
        onTestFinished(async () => {
          (await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))._unsafeUnwrap();
        });
      }
      let db: import("../pg/client.ts").PostgreSQLClient;
      if (admin) {
        (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
        const url = new URL(postgres!);
        url.searchParams.set("options", `-c search_path=${schema}`);
        db = new PgClient(url.toString());
      } else db = new PGliteClient();
      onTestFinished(async () => {
        (await db.end())._unsafeUnwrap();
      });
      const orb = "00000000-0000-4000-8000-000000000001";
      {
        (
          await db.query(
            "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
          )
        )._unsafeUnwrap();
        (
          await db.query("INSERT INTO orbs(id) VALUES($1) ON CONFLICT DO NOTHING", [orb])
        )._unsafeUnwrap();
        const migration = await readFile(
          new URL("../pg/migrations/036_durable_authority.sql", import.meta.url),
          "utf8",
        );
        (await db.transaction(async (_query, execute) => execute(migration)))._unsafeUnwrap();
        const authority = new PgDurableAuthority(db, () => 0);
        const owner = (await authority.acquire(orb, "test", 0, 0, 1000))._unsafeUnwrap();
        const storage = (
          await authority.open(owner, { project: async () => ok(undefined) })
        )._unsafeUnwrap();
        onTestFinished(() => storage.close({} as never));
        await use(storage);
      }
    },
  });
  // Network PG cases each get a schema in the test database; this file's cases run sequentially.
  for (const entry of cases) it(`${backend}: ${entry.name}`, entry.run);
}
