import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "../pg/pglite-client.ts";
import { PgAgentPersistence } from "./pg-persistence.ts";

it("fences an open lease when admission authority changes and reads public history passively", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("pg-lease", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  const persistence = database.agentPersistence;
  expect(persistence).toBeInstanceOf(PgAgentPersistence);
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
    const lease = (
      await persistence.open(task, orb, { signal: new AbortController().signal })
    )._unsafeUnwrap();
    expect((await lease.check()).isOk()).toBe(true);
    (
      await db.query("UPDATE orbs SET agent_admission_version=1 WHERE id=$1", [orb.id])
    )._unsafeUnwrap();
    expect((await lease.check()).isErr()).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    (await lease.release())._unsafeUnwrap();
    const empty = (await persistence.snapshot(task, orb))._unsafeUnwrap();
    expect(empty.session.id).toBe(`conversation:${orb.id}`);
    expect(empty.records).toEqual([]);
    expect(
      (await db.query("SELECT count(*) AS n FROM durable_pg_conversations"))._unsafeUnwrap().rows[0]
        ?.n,
    ).toBe(0);
  } finally {
    await persistence.close();
    await database.close();
  }
});
