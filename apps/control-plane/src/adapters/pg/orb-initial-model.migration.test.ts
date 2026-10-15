import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

it("upgrades existing orbs to null and accepts only closed canonical model refs", async () => {
  const client = new PGliteClient();
  const database = composeControlPlaneDatabase(client);
  const task = new NoSimulationTask("initial model migration", false);
  try {
    (await database.migrate())._unsafeUnwrap();
    (
      await client.query(
        "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'test', 'owner', now(), now())",
        [TEST_USER_ID],
      )
    )._unsafeUnwrap();
    const project = makeProjectRow("00000000-0000-4000-8000-000000000011");
    const orb = makeOrbRow("00000000-0000-4000-8000-000000000012", project.id, "creating");
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    (await client.query("ALTER TABLE orbs DROP COLUMN initial_model"))._unsafeUnwrap();
    (
      await client.query("DELETE FROM schema_migrations WHERE name = '046_orb_initial_model.sql'")
    )._unsafeUnwrap();
    expect((await database.migrate())._unsafeUnwrap()).toEqual(["046_orb_initial_model.sql"]);
    expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.initialModel).toBeNull();
    for (const invalid of [
      null,
      [],
      {},
      { provider: "", id: "opus" },
      { provider: "claude", id: "" },
      { provider: "claude", id: "opus", extra: true },
      { provider: 1, id: "opus" },
    ]) {
      expect(
        (
          await client.query("UPDATE orbs SET initial_model = $2::jsonb WHERE id = $1", [
            orb.id,
            JSON.stringify(invalid),
          ])
        ).isErr(),
      ).toBe(true);
    }
    const model = { provider: "claude", id: "sonnet" };
    (
      await client.query("UPDATE orbs SET initial_model = $2::jsonb WHERE id = $1", [
        orb.id,
        JSON.stringify(model),
      ])
    )._unsafeUnwrap();
    expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.initialModel).toEqual(
      model,
    );
  } finally {
    (await database.close())._unsafeUnwrap();
  }
});
