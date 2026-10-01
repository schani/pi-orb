import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("orb zone migration", false);

describe("orb zone migration", () => {
  it("upgrades an existing orb with an unknown zone", async () => {
    const client = new PGliteClient();
    const database = composeControlPlaneDatabase(client);
    try {
      expect((await database.migrate()).isOk()).toBe(true);
      const project = makeProjectRow("00000000-0000-4000-8000-000000000011");
      const orb = makeOrbRow("00000000-0000-4000-8000-000000000012", project.id, "creating");
      expect(
        (
          await client.query(
            "INSERT INTO users (id, identity_issuer, identity_subject, created_at, updated_at) VALUES ($1, 'test', 'owner', now(), now())",
            [TEST_USER_ID],
          )
        ).isOk(),
      ).toBe(true);
      expect((await database.store.insertProject(task, project)).isOk()).toBe(true);
      expect((await database.store.insertOrb(task, orb)).isOk()).toBe(true);
      expect((await client.query("ALTER TABLE orbs DROP COLUMN user_time_zone")).isOk()).toBe(true);
      expect(
        (
          await client.query(
            "DELETE FROM schema_migrations WHERE name = '027_orb_user_time_zone.sql'",
          )
        ).isOk(),
      ).toBe(true);
      expect((await database.migrate())._unsafeUnwrap()).toEqual(["027_orb_user_time_zone.sql"]);
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.userTimeZone).toBeNull();
      expect(
        (
          await client.query("SELECT user_time_zone FROM orbs WHERE id = $1", [orb.id])
        )._unsafeUnwrap().rows[0]?.["user_time_zone"],
      ).toBeNull();
    } finally {
      expect((await database.close()).isOk()).toBe(true);
    }
  });
});
