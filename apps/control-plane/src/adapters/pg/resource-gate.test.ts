import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { resourceError } from "../../domain/resources.ts";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";
import { PgResourceGate } from "./resource-gate.ts";

it("publishes the pin once, restores without Git, and fences Stop before late publication", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("resources", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "starting");
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
    let calls = 0;
    const gate = new PgResourceGate(db, {
      acquire: () => {
        calls++;
        return okAsync({
          orbId: orb.id,
          commitSha: "a".repeat(40),
          instructionPath: null,
          skillRoot: null,
          files: [],
        });
      },
    });
    const context = { signal: new AbortController().signal };
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    (await gate.acquire(task, orb, context))._unsafeUnwrap();
    expect(calls).toBe(1);
    expect((await gate.initialPin(task, orb))._unsafeUnwrap()).toBe("a".repeat(40));
    (
      await db.query("DELETE FROM orb_resource_snapshots WHERE orb_id=$1", [orb.id])
    )._unsafeUnwrap();
    const late = new PgResourceGate(db, {
      acquire: () =>
        db
          .query("UPDATE orbs SET agent_admission_version=1 WHERE id=$1", [orb.id])
          .mapErr(() => resourceError("storage", "test"))
          .map(() => ({
            orbId: orb.id,
            commitSha: "b".repeat(40),
            instructionPath: null,
            skillRoot: null,
            files: [],
          })),
    });
    expect((await late.acquire(task, orb, context)).isErr()).toBe(true);
    expect(
      (await db.query("SELECT count(*) AS n FROM orb_resource_snapshots"))._unsafeUnwrap().rows[0]
        ?.n,
    ).toBe(0);
    const current = { ...orb, agentAdmissionVersion: 1 };
    const failed = new PgResourceGate(db, {
      acquire: () => errAsync(resourceError("fetch", "sanitized")),
    });
    expect((await failed.acquire(task, current, context)).isErr()).toBe(true);
    expect((await failed.initialPin(task, current)).isErr()).toBe(true);
  } finally {
    await database.close();
  }
});
