import { NoSimulationTask } from "determined";
import { beforeEach, describe, expect, it } from "vitest";
import { makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { assertProjectDeletionFence, openThrowawayPostgres } from "../../testkit/postgres.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import type { PostgreSQLClient } from "./client.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PostgreSQLProjectInstructionsStore } from "./project-instructions.ts";

const task = new NoSimulationTask("project instructions SQL", false);
const A = "00000000-0000-4000-8000-000000000071";
const B = "00000000-0000-4000-8000-000000000072";
const url = process.env["PI_ORB_TEST_DATABASE_URL"];
describe.each(["PGlite", ...(url ? ["PostgreSQL"] : [])])("%s project-instructions", (backend) => {
  let db: PostgreSQLClient;
  let store: PostgreSQLProjectInstructionsStore;
  beforeEach(async ({ onTestFinished }) => {
    const subject =
      backend === "PostgreSQL" && url
        ? await openThrowawayPostgres(url)
        : (() => {
            const client = new PGliteClient();
            return { client, database: composeControlPlaneDatabase(client) };
          })();
    onTestFinished(async () => {
      const closed = await subject.database.close();
      expect(closed.isOk(), JSON.stringify(closed)).toBe(true);
    });
    db = subject.client;
    const database = subject.database;
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    for (const id of [A, B])
      (await database.store.insertProject(task, makeProjectRow(id)))._unsafeUnwrap();
    store = new PostgreSQLProjectInstructionsStore(db);
  });
  it("seeds empty, serializes assignments, preserves exact text and isolates projects", async () => {
    expect((await store.read(task, A))._unsafeUnwrap()).toEqual({ content: "", revision: 0 });
    const other = new PostgreSQLProjectInstructionsStore(db);
    const results = await Promise.all([
      store.replace(task, A, "alpha\r\n"),
      other.replace(task, A, "🪐 beta\n"),
    ]);
    const commits = results.map((r) => r._unsafeUnwrap()).sort((a, b) => a.revision - b.revision);
    expect(commits.map((c) => c.revision)).toEqual([1, 2]);
    expect((await store.read(task, A))._unsafeUnwrap()).toEqual(commits[1]);
    expect((await store.read(task, B))._unsafeUnwrap()).toEqual({ content: "", revision: 0 });
    expect((await store.replace(task, A, ""))._unsafeUnwrap()).toEqual({
      content: "",
      revision: 3,
    });
    (await composeControlPlaneDatabase(db).migrate())._unsafeUnwrap();
    expect((await other.read(task, A))._unsafeUnwrap().revision).toBe(3);
  });
  it.each(["save-first", "delete-first"])("deletion fencing: %s", async (order) => {
    if (order === "save-first") (await store.replace(task, A, "before deletion"))._unsafeUnwrap();
    (await db.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [A]))._unsafeUnwrap();
    expect((await store.replace(task, A, "after deletion"))._unsafeUnwrapErr().code).toBe(
      "conflict",
    );
    expect((await store.read(task, A))._unsafeUnwrapErr().code).toBe("conflict");
    const row = (
      await db.query("SELECT instructions_revision FROM projects WHERE id = $1", [A])
    )._unsafeUnwrap().rows[0];
    expect(Number(row?.["instructions_revision"])).toBe(order === "save-first" ? 1 : 0);
    (await db.query("DELETE FROM projects WHERE id = $1", [A]))._unsafeUnwrap();
    expect((await store.read(task, A))._unsafeUnwrapErr().code).toBe("not_found");
    expect((await store.replace(task, A, "no recreation"))._unsafeUnwrapErr().code).toBe(
      "not_found",
    );
  });
  it("fails exhaustion atomically and malformed ids are missing rather than SQL errors", async () => {
    (
      await db.query("UPDATE projects SET instructions_revision = $1 WHERE id = $2", [
        Number.MAX_SAFE_INTEGER,
        A,
      ])
    )._unsafeUnwrap();
    expect((await store.replace(task, A, "must not commit"))._unsafeUnwrapErr().code).toBe(
      "internal",
    );
    expect((await store.read(task, A))._unsafeUnwrap()).toEqual({
      content: "",
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect((await store.read(task, "missing"))._unsafeUnwrapErr().code).toBe("not_found");
  });

  it.skipIf(backend !== "PostgreSQL")(
    "waits for the project row lock and observes the committed deletion fence",
    async () => {
      if (!url) return;
      await assertProjectDeletionFence(db, url, A, (peer) =>
        new PostgreSQLProjectInstructionsStore(peer).replace(task, A, "must not publish"),
      );
      expect(
        (
          await db.query("SELECT instructions_revision FROM projects WHERE id = $1", [A])
        )._unsafeUnwrap().rows,
      ).toEqual([{ instructions_revision: "0" }]);
    },
  );
});
