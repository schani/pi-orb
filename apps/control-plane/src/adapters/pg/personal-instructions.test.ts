import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import { type ControlPlaneDatabase, composeControlPlaneDatabase } from "../database.ts";
import type { PostgreSQLClient } from "./client.ts";
import { PostgreSQLPersonalInstructionsStore } from "./personal-instructions.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("personal-instructions SQL", false);
const ALICE = "00000000-0000-4000-8000-000000000001";
const BOB = "00000000-0000-4000-8000-000000000002";
let db: PostgreSQLClient;
let database: ControlPlaneDatabase;
let store: PostgreSQLPersonalInstructionsStore;
beforeEach(async () => {
  const connectionString = process.env["PI_ORB_TEST_DATABASE_URL"];
  if (connectionString) {
    const subject = await openThrowawayPostgres(connectionString);
    db = subject.client;
    database = subject.database;
  } else {
    db = new PGliteClient();
    database = composeControlPlaneDatabase(db);
  }
  (await database.migrate())._unsafeUnwrap();
  for (const [id, subject] of [
    [ALICE, "alice"],
    [BOB, "bob"],
  ] as const)
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject, email: null },
        { id, now: 0 },
      )
    )._unsafeUnwrap();
  store = new PostgreSQLPersonalInstructionsStore(db);
});
afterEach(async () => {
  await db.end();
});

it("keeps implicit defaults and revisions independent per user", async () => {
  expect((await store.read(task, ALICE))._unsafeUnwrap()).toEqual({ content: "", revision: 0 });
  expect((await store.read(task, BOB))._unsafeUnwrap()).toEqual({ content: "", revision: 0 });
  const other = new PostgreSQLPersonalInstructionsStore(db);
  const replies = await Promise.all([
    store.replace(task, ALICE, "alpha\r\n"),
    other.replace(task, ALICE, "🪐 beta\n"),
  ]);
  const committed = replies
    .map((reply) => reply._unsafeUnwrap())
    .sort((a, b) => a.revision - b.revision);
  expect(committed.map((item) => item.revision)).toEqual([1, 2]);
  expect((await other.read(task, ALICE))._unsafeUnwrap()).toEqual(committed[1]);
  expect((await store.replace(task, BOB, "bob"))._unsafeUnwrap()).toEqual({
    content: "bob",
    revision: 1,
  });
  expect((await store.read(task, ALICE))._unsafeUnwrap().revision).toBe(2);
  (await database.migrate())._unsafeUnwrap();
  expect((await store.read(task, BOB))._unsafeUnwrap().revision).toBe(1);
});
it("fails revision exhaustion atomically rather than wrapping", async () => {
  (await store.replace(task, ALICE, ""))._unsafeUnwrap();
  (
    await db.query("UPDATE personal_instructions SET revision = $1 WHERE user_id = $2", [
      Number.MAX_SAFE_INTEGER,
      ALICE,
    ])
  )._unsafeUnwrap();
  expect((await store.replace(task, ALICE, "must not commit"))._unsafeUnwrapErr().code).toBe(
    "internal",
  );
  expect((await store.read(task, ALICE))._unsafeUnwrap().revision).toBe(Number.MAX_SAFE_INTEGER);
});
it("rejects unknown users and never creates settings for them", async () => {
  const unknown = "00000000-0000-4000-8000-000000000099";
  expect((await store.read(task, unknown)).isErr()).toBe(true);
  expect((await store.replace(task, unknown, "no silent creation")).isErr()).toBe(true);
  expect(
    (
      await db.query("SELECT * FROM personal_instructions WHERE user_id = $1", [unknown])
    )._unsafeUnwrap().rows,
  ).toEqual([]);
});
