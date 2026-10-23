import { NoSimulationTask } from "determined";
import { beforeEach, expect, it } from "vitest";
import { ALICE, BOB, openTwoUserSqlFixture } from "../../testkit/sql-fixture.ts";
import type { ControlPlaneDatabase } from "../database.ts";
import type { PostgreSQLClient } from "./client.ts";
import { PostgreSQLGitIdentityStore } from "./git-identity.ts";

const task = new NoSimulationTask("git-identity SQL", false);
let db: PostgreSQLClient;
let database: ControlPlaneDatabase;
let store: PostgreSQLGitIdentityStore;
beforeEach(async () => {
  const fixture = await openTwoUserSqlFixture(task);
  db = fixture.db;
  database = fixture.database;
  const { migrations } = fixture;
  expect(migrations).toContain("042_git_identities.sql");
  store = new PostgreSQLGitIdentityStore(db);
});

it("reads a missing row as cleared and overwrites per user", async () => {
  expect((await store.read(task, ALICE))._unsafeUnwrap()).toEqual({ name: "", email: "" });
  const ada = { name: "Ada", email: "ada@example.com" };
  expect((await store.replace(task, ALICE, ada))._unsafeUnwrap()).toEqual(ada);
  const grace = { name: "Grace", email: "grace@example.com" };
  expect((await store.replace(task, ALICE, grace))._unsafeUnwrap()).toEqual(grace);
  expect((await store.read(task, ALICE))._unsafeUnwrap()).toEqual(grace);
  expect((await store.read(task, BOB))._unsafeUnwrap()).toEqual({ name: "", email: "" });
  const cleared = { name: "", email: "" };
  expect((await store.replace(task, ALICE, cleared))._unsafeUnwrap()).toEqual(cleared);
  expect((await store.read(task, ALICE))._unsafeUnwrap()).toEqual(cleared);
  (await database.migrate())._unsafeUnwrap();
  expect(
    (await db.query("SELECT user_id FROM git_identities"))
      ._unsafeUnwrap()
      .rows.map((row) => row["user_id"]),
  ).toEqual([ALICE]);
});

it("rejects unknown users and never creates rows for them", async () => {
  const unknown = "00000000-0000-4000-8000-000000000099";
  expect((await store.read(task, unknown)).isErr()).toBe(true);
  expect((await store.replace(task, unknown, { name: "A", email: "a@b" })).isErr()).toBe(true);
  expect(
    (await db.query("SELECT * FROM git_identities WHERE user_id = $1", [unknown]))._unsafeUnwrap()
      .rows,
  ).toEqual([]);
});
