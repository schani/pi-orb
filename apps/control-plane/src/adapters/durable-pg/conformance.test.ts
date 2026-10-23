import { readFile } from "node:fs/promises";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { PgClient } from "../pg/client.ts";
import { runMigrations } from "../pg/migrate.ts";
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
        (await runMigrations(db))._unsafeUnwrap();
        const { NoSimulationTask } = await import("determined");
        const { composeControlPlaneDatabase } = await import("../database.ts");
        const { makeOrbRow, makeProjectRow, seedTestUser } = await import(
          "../../testkit/fixtures.ts"
        );
        const task = new NoSimulationTask("conformance", false);
        const database = composeControlPlaneDatabase(db);
        const project = makeProjectRow("00000000-0000-4000-8000-000000000002");
        (await seedTestUser(task, database.users))._unsafeUnwrap();
        (await database.store.insertProject(task, project))._unsafeUnwrap();
        (
          await database.store.insertOrb(task, makeOrbRow(orb, project.id, "running"))
        )._unsafeUnwrap();
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
  // Network PG cases each get a schema in the test database; this file's cases run sequentially.
  for (const entry of cases) it(`${backend}: ${entry.name}`, entry.run);
}

for (const backend of ["pglite", ...(postgres ? ["postgres"] : [])]) {
  it(`${backend}: upgrades the 036 task constraint without rewriting records`, async () => {
    const schema = `durable_upgrade_${process.pid}`;
    const admin = backend === "postgres" ? new PgClient(postgres!) : undefined;
    let db = new PGliteClient() as import("../pg/client.ts").PostgreSQLClient;
    if (admin) {
      (await admin.query(`CREATE SCHEMA ${schema}`))._unsafeUnwrap();
      (await db.end())._unsafeUnwrap();
      const url = new URL(postgres!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      db = new PgClient(url.toString());
    }
    try {
      (
        await db.query(
          "CREATE TABLE orbs(id uuid PRIMARY KEY, agent_admission_version bigint NOT NULL DEFAULT 0)",
        )
      )._unsafeUnwrap();
      const orb = "00000000-0000-4000-8000-000000000001";
      (await db.query("INSERT INTO orbs(id) VALUES($1)", [orb]))._unsafeUnwrap();
      const apply = async (name: string) => {
        const sql = await readFile(new URL(`../pg/migrations/${name}`, import.meta.url), "utf8");
        (await db.transaction(async (_query, execute) => execute(sql)))._unsafeUnwrap();
      };
      await apply("036_durable_authority.sql");
      const record =
        '{"id":1,"state":{"status":"terminal","outcome":{"kind":"completed","result":"unchanged"}}}';
      (
        await db.query("INSERT INTO durable_pg_tasks VALUES($1,1,1,'test','terminal',0,0,$2)", [
          orb,
          record,
        ])
      )._unsafeUnwrap();
      expect((await db.query("UPDATE durable_pg_tasks SET status='sleeping'")).isErr()).toBe(true);
      await apply("049_durable_sleeping.sql");
      expect((await db.query("SELECT record FROM durable_pg_tasks"))._unsafeUnwrap().rows).toEqual([
        { record },
      ]);
      (await db.query("UPDATE durable_pg_tasks SET status='sleeping'"))._unsafeUnwrap();
      expect((await db.query("UPDATE durable_pg_tasks SET status='unknown'")).isErr()).toBe(true);
    } finally {
      (await db.end())._unsafeUnwrap();
      if (admin) {
        (await admin.query(`DROP SCHEMA ${schema} CASCADE`))._unsafeUnwrap();
        (await admin.end())._unsafeUnwrap();
      }
    }
  });
}
