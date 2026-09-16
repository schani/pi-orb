import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PostgreSQLProjectInstructionsStore } from "./project-instructions.ts";

const task = new NoSimulationTask("project instructions SQL", false);
const A = "00000000-0000-4000-8000-000000000071";
const B = "00000000-0000-4000-8000-000000000072";
let db: PGliteClient;
let store: PostgreSQLProjectInstructionsStore;
beforeEach(async () => {
  db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  (await database.migrate())._unsafeUnwrap();
  for (const id of [A, B])
    (await database.store.insertProject(task, makeProjectRow(id)))._unsafeUnwrap();
  store = new PostgreSQLProjectInstructionsStore(db);
});
afterEach(async () => {
  await db.end();
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
  expect((await store.replace(task, A, ""))._unsafeUnwrap()).toEqual({ content: "", revision: 3 });
  (await composeControlPlaneDatabase(db).migrate())._unsafeUnwrap();
  expect((await other.read(task, A))._unsafeUnwrap().revision).toBe(3);
});
it.each(["save-first", "delete-first"])("deletion fencing: %s", async (order) => {
  if (order === "save-first") (await store.replace(task, A, "before deletion"))._unsafeUnwrap();
  (await db.query("UPDATE projects SET state = 'deleting' WHERE id = $1", [A]))._unsafeUnwrap();
  expect((await store.replace(task, A, "after deletion"))._unsafeUnwrapErr().code).toBe("conflict");
  expect((await store.read(task, A))._unsafeUnwrapErr().code).toBe("conflict");
  const row = (
    await db.query("SELECT instructions_revision FROM projects WHERE id = $1", [A])
  )._unsafeUnwrap().rows[0];
  expect(Number(row?.["instructions_revision"])).toBe(order === "save-first" ? 1 : 0);
  (await db.query("DELETE FROM projects WHERE id = $1", [A]))._unsafeUnwrap();
  expect((await store.read(task, A))._unsafeUnwrapErr().code).toBe("not_found");
  expect((await store.replace(task, A, "no recreation"))._unsafeUnwrapErr().code).toBe("not_found");
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
