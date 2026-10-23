import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
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

it("derives recovery demand from indexed Native status without acquiring ownership", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("pg-recovery-demand", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "stopped", { stopReason: "idle" });
  const other = makeOrbRow(randomUUID(), project.id, "stopped", { stopReason: "idle" });
  const context = { signal: new AbortController().signal };
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    for (const row of [orb, other]) (await database.store.insertOrb(task, row))._unsafeUnwrap();
    const persistence = database.agentPersistence;
    expect((await persistence.recoveryDemand(task, orb, context))._unsafeUnwrap()).toBe(false);
    // No metadata or readable payload: the predicate needs only indexed status.
    for (const conversationId of [1, 20]) {
      for (const status of [
        "pending",
        "running",
        "sleeping",
        "waiting",
        "completing",
        "terminal",
      ]) {
        (
          await db.query(
            "INSERT INTO durable_pg_tasks(orb_id,id,conversation_id,kind,status,abort_requested,background,record) VALUES($1,10,$2,'task',$3,1,1,'{}')",
            [orb.id, conversationId, status],
          )
        )._unsafeUnwrap();
        expect(
          (await persistence.recoveryDemand(task, orb, context))._unsafeUnwrap(),
          `task ${conversationId}/${status}`,
        ).toBe(status !== "terminal");
        (await db.query("DELETE FROM durable_pg_tasks WHERE orb_id=$1", [orb.id]))._unsafeUnwrap();
      }
      for (const status of ["queued", "placed", "done", "unanswered"]) {
        (
          await db.query(
            "INSERT INTO durable_pg_submissions(orb_id,id,conversation_id,status,record) VALUES($1,10,$2,$3,'{}')",
            [orb.id, conversationId, status],
          )
        )._unsafeUnwrap();
        expect(
          (await persistence.recoveryDemand(task, orb, context))._unsafeUnwrap(),
          `submission ${conversationId}/${status}`,
        ).toBe(status === "queued" || status === "placed");
        (
          await db.query("DELETE FROM durable_pg_submissions WHERE orb_id=$1", [orb.id])
        )._unsafeUnwrap();
      }
    }
    (
      await db.query(
        "INSERT INTO durable_pg_tasks(orb_id,id,conversation_id,kind,status,abort_requested,background,record) VALUES($1,10,1,'task','pending',0,0,'{}')",
        [other.id],
      )
    )._unsafeUnwrap();
    expect((await persistence.recoveryDemand(task, orb, context))._unsafeUnwrap()).toBe(false);
    expect((await persistence.recoveryDemand(task, other, context))._unsafeUnwrap()).toBe(true);
    for (const table of [
      "durable_pg_owners",
      "durable_pg_owner_events",
      "durable_pg_durable_metadata",
    ]) {
      expect(
        (await db.query(`SELECT count(*) AS n FROM ${table}`))._unsafeUnwrap().rows[0]?.n,
      ).toBe(0);
    }
  } finally {
    await database.agentPersistence.close();
    await database.close();
  }
});
