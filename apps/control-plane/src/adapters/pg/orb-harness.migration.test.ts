import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, TEST_USER_ID } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("orb harness migration", false);

describe("orb harness migration", () => {
  it("defaults existing orbs to Pi and persists Claude across state changes", async () => {
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
      expect((await client.query("ALTER TABLE orbs DROP COLUMN harness")).isOk()).toBe(true);
      expect(
        (
          await client.query("DELETE FROM schema_migrations WHERE name = '029_orb_harness.sql'")
        ).isOk(),
      ).toBe(true);
      expect((await database.migrate())._unsafeUnwrap()).toEqual(["029_orb_harness.sql"]);
      expect((await database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harness).toBe("pi");
      const claude = {
        ...orb,
        id: "00000000-0000-4000-8000-000000000013",
        harness: "claude" as const,
      };
      expect((await database.store.insertOrb(task, claude)).isOk()).toBe(true);
      for (const state of ["starting", "running", "stopping", "stopped", "starting"]) {
        expect(
          (
            await client.query("UPDATE orbs SET state = $2 WHERE id = $1", [claude.id, state])
          ).isOk(),
        ).toBe(true);
        expect((await database.store.getOrb(task, claude.id))._unsafeUnwrap()?.harness).toBe(
          "claude",
        );
      }
      expect(
        (
          await client.query("UPDATE orbs SET harness = 'unknown' WHERE id = $1", [claude.id])
        ).isErr(),
      ).toBe(true);
    } finally {
      expect((await database.close()).isOk()).toBe(true);
    }
  });
});
