import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, expect, it } from "vitest";
import { composeControlPlaneDatabase } from "../database.ts";
import { PostgreSQLPersonalInstructionsStore } from "./personal-instructions.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("personal-instructions SQL", false);
let db: PGliteClient;
let store: PostgreSQLPersonalInstructionsStore;
beforeEach(async () => {
  db = new PGliteClient();
  (await composeControlPlaneDatabase(db).migrate())._unsafeUnwrap();
  store = new PostgreSQLPersonalInstructionsStore(db);
});
afterEach(async () => {
  await db.end();
});

it("seeds one empty document and atomically serializes assignments across connections to the store", async () => {
  expect((await store.read(task))._unsafeUnwrap()).toEqual({ content: "", revision: 0 });
  const other = new PostgreSQLPersonalInstructionsStore(db);
  const replies = await Promise.all([
    store.replace(task, "alpha\r\n"),
    other.replace(task, "🪐 beta\n"),
  ]);
  const committed = replies
    .map((reply) => reply._unsafeUnwrap())
    .sort((a, b) => a.revision - b.revision);
  expect(committed.map((item) => item.revision)).toEqual([1, 2]);
  expect((await other.read(task))._unsafeUnwrap()).toEqual(committed[1]);
  expect((await store.replace(task, ""))._unsafeUnwrap()).toEqual({ content: "", revision: 3 });
  expect((await new PostgreSQLPersonalInstructionsStore(db).read(task))._unsafeUnwrap()).toEqual({
    content: "",
    revision: 3,
  });
  (await composeControlPlaneDatabase(db).migrate())._unsafeUnwrap();
  expect((await store.read(task))._unsafeUnwrap().revision).toBe(3);
});
it("fails revision exhaustion atomically rather than wrapping or publishing unversioned text", async () => {
  (
    await db.query("UPDATE personal_instructions SET revision = $1", [Number.MAX_SAFE_INTEGER])
  )._unsafeUnwrap();
  expect((await store.replace(task, "must not commit"))._unsafeUnwrapErr().code).toBe("internal");
  expect((await store.read(task))._unsafeUnwrap()).toEqual({
    content: "",
    revision: Number.MAX_SAFE_INTEGER,
  });
});
it("does not turn missing/corrupt persisted state into empty success", async () => {
  (await db.query("DELETE FROM personal_instructions"))._unsafeUnwrap();
  expect((await store.read(task)).isErr()).toBe(true);
  expect((await store.replace(task, "no silent recreation")).isErr()).toBe(true);
});
