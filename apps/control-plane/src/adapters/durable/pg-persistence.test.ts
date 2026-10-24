import { randomUUID } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync } from "neverthrow";
import { expect, it } from "vitest";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import type { PostgreSQLClient } from "../pg/client.ts";
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

it("uses the injected authority clock for lease deadlines and expiry", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("pg-lease-clock", false);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  let now = 1_000;
  const persistence = new PgAgentPersistence(db, database.store, () => now);
  const deadline = async () =>
    Number(
      (
        await db.query("SELECT lease_until FROM durable_pg_owners WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows[0]?.lease_until,
    );
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const lease = (
      await persistence.open(task, orb, { signal: new AbortController().signal })
    )._unsafeUnwrap();
    expect(await deadline()).toBe(now + 60_000);
    now += 10_000;
    (await lease.check())._unsafeUnwrap();
    expect(await deadline()).toBe(now + 60_000);
    now += 60_000;
    expect((await lease.check()).isErr()).toBe(true);
    expect(lease.signal.aborted).toBe(true);
  } finally {
    try {
      (await persistence.close())._unsafeUnwrap();
    } finally {
      (await database.close())._unsafeUnwrap();
    }
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
      for (const status of ["pending", "running", "waiting", "completing", "terminal"]) {
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

it("retains failed ownership release for an idempotent persistence-close retry", async () => {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  let unavailable = false;
  const client: PostgreSQLClient = {
    query: db.query.bind(db),
    end: db.end.bind(db),
    transaction: (f) =>
      unavailable
        ? errAsync({
            type: "store_error",
            code: "unavailable",
            message: "injected outage",
            retryable: true,
          })
        : db.transaction(f),
  };
  const task = new NoSimulationTask("pg-release-retry", false);
  const persistence = new PgAgentPersistence(client, database.store, () => 0);
  const project = makeProjectRow(randomUUID());
  const orb = makeOrbRow(randomUUID(), project.id, "running");
  try {
    (await database.migrate())._unsafeUnwrap();
    (await seedTestUser(task, database.users))._unsafeUnwrap();
    (await database.store.insertProject(task, project))._unsafeUnwrap();
    (await database.store.insertOrb(task, orb))._unsafeUnwrap();
    const lease = (
      await persistence.open(task, orb, { signal: new AbortController().signal })
    )._unsafeUnwrap();
    unavailable = true;
    const first = lease.release();
    expect(lease.release()).toBe(first);
    expect((await first).isErr()).toBe(true);
    expect((await persistence.close()).isErr()).toBe(true);
    unavailable = false;
    (await persistence.close())._unsafeUnwrap();
    (await lease.release())._unsafeUnwrap();
    expect(
      (
        await db.query("SELECT fence,lease_until FROM durable_pg_owners WHERE orb_id=$1", [orb.id])
      )._unsafeUnwrap().rows,
    ).toMatchObject([{ fence: 2, lease_until: 0 }]);
  } finally {
    unavailable = false;
    await persistence.close();
    await database.close();
  }
});

it.each(["expired", "unavailable"] as const)(
  "classifies drain after %s renewal without trusting abort",
  async (reason) => {
    const db = new PGliteClient();
    const database = composeControlPlaneDatabase(db);
    let unavailable = false,
      now = 0;
    const client: PostgreSQLClient = {
      query: db.query.bind(db),
      end: db.end.bind(db),
      transaction: (f) =>
        unavailable
          ? errAsync({
              type: "store_error",
              code: "unavailable",
              message: "injected outage",
              retryable: true,
            })
          : db.transaction(f),
    };
    const task = new NoSimulationTask("pg-drain-classification", false);
    const persistence = new PgAgentPersistence(client, database.store, () => now);
    const project = makeProjectRow(randomUUID());
    const orb = makeOrbRow(randomUUID(), project.id, "running");
    try {
      (await database.migrate())._unsafeUnwrap();
      (await seedTestUser(task, database.users))._unsafeUnwrap();
      (await database.store.insertProject(task, project))._unsafeUnwrap();
      (await database.store.insertOrb(task, orb))._unsafeUnwrap();
      const lease = (
        await persistence.open(task, orb, { signal: new AbortController().signal })
      )._unsafeUnwrap();
      if (reason === "expired") now = 60_000;
      else unavailable = true;
      expect((await lease.check())._unsafeUnwrapErr()).toMatchObject({
        cause: { code: reason === "expired" ? "stale_owner" : "unavailable" },
      });
      expect(lease.signal.aborted).toBe(true);
      if (unavailable) {
        expect((await lease.beginDrain())._unsafeUnwrapErr()).toMatchObject({
          cause: { code: "unavailable" },
        });
      }
      unavailable = false;
      const draining = (await lease.beginDrain())._unsafeUnwrap();
      if (reason === "expired")
        expect(draining).toMatchObject({ type: "owner_lost", cause: { code: "stale_owner" } });
      else expect(draining).toBeUndefined();
      (await lease.release())._unsafeUnwrap();
    } finally {
      unavailable = false;
      await persistence.close();
      await database.close();
    }
  },
);
