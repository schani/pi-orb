import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PgDurableAuthority } from "../durable-pg/index.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgAgentArtifacts } from "./pg-artifacts.ts";

it("keeps spill bytes private, orb scoped and owner fenced", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("artifacts", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  try {
    (await database.migrate())._unsafeUnwrap();
    (
      await database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const authority = new PgDurableAuthority(db, () => 0);
    const owner = (await authority.acquire(orb.id, "test", 0, 0, 1000))._unsafeUnwrap();
    const files = new PgAgentArtifacts(authority, owner);
    const path = (await files.write(Buffer.from("private output")))._unsafeUnwrap();
    expect(path).toMatch(/^\/orb-artifacts\/[a-f0-9-]+$/);
    expect(Buffer.from((await files.read(path))._unsafeUnwrap()!).toString()).toBe(
      "private output",
    );
    expect((await files.read("/etc/passwd"))._unsafeUnwrap()).toBeNull();
    (
      await db.query("UPDATE orbs SET agent_admission_version=1 WHERE id=$1", [orb.id])
    )._unsafeUnwrap();
    expect((await files.write(Buffer.from("late"))).isErr()).toBe(true);
    expect((await files.read(path)).isErr()).toBe(true);
    expect(
      (await db.query("SELECT count(*) AS n FROM orb_agent_artifacts"))._unsafeUnwrap().rows[0]?.n,
    ).toBe(1);
  } finally {
    await database.close();
  }
});
