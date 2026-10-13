import { randomUUID } from "node:crypto";
import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOrbForIntegrity } from "../../domain/replication.ts";
import { makeHarness, makeOrbRow, makeProjectRow, seedTestUser } from "../../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import type { StoreContractSubject } from "../../testkit/store-contract.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("history-text", false);
const migration = "044_lossless_history_json.sql";
const url = process.env["PI_ORB_TEST_DATABASE_URL"];
const session: HarnessSessionMetadata = { id: "session", overflow: {} };
const boundaryError = { type: "store_error", code: "invariant", retryable: false };
const record: HistoryRecord = {
  id: "record",
  parentId: null,
  timestamp: "2026-10-13T00:00:00.000Z",
  type: "message",
  role: "tool",
  content: [{ type: "text", text: "safe" }],
  overflow: {},
};
const initial = { session, cursor: record.id, headId: record.id, records: [record] };

describe.each(["PGlite", ...(url ? ["PostgreSQL"] : [])])("%s lossless history", (driver) => {
  let subject: StoreContractSubject;
  let project: ReturnType<typeof makeProjectRow>;
  let orb: ReturnType<typeof makeOrbRow>;
  const query = async (sql: string, values: unknown[] = []) =>
    (await subject.client.query(sql, values))._unsafeUnwrap();
  const snapshot = async () =>
    (await subject.database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap();
  const commit = (records: HistoryRecord[]) =>
    subject.database.store.commitPullBatch(task, {
      orbId: orb.id,
      expectedCursor: record.id,
      session,
      records,
      nextCursor: records.at(-1)?.id ?? record.id,
      nextHeadId: records.at(-1)?.id ?? record.id,
    });

  beforeEach(async () => {
    if (driver === "PostgreSQL") subject = await openThrowawayPostgres(url ?? "");
    else {
      const client = new PGliteClient();
      subject = { client, database: composeControlPlaneDatabase(client) };
    }
    await query(
      "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration]);
    (await subject.database.migrate())._unsafeUnwrap();
    project = makeProjectRow(randomUUID());
    orb = makeOrbRow(randomUUID(), project.id, "running");
    (await seedTestUser(task, subject.database.users))._unsafeUnwrap();
    (await subject.database.store.insertProject(task, project))._unsafeUnwrap();
    (await subject.database.store.insertOrb(task, orb))._unsafeUnwrap();
    await query(
      "UPDATE orbs SET harness_session_id=$2, harness_session_header=$3::jsonb WHERE id=$1",
      [orb.id, session.id, JSON.stringify(session)],
    );
    await query(
      "INSERT INTO history_records (orb_id,record_id,parent_id,record) VALUES ($1,$2,NULL,$3::jsonb)",
      [orb.id, record.id, JSON.stringify(record)],
    );
    await query("UPDATE orbs SET replication_cursor=$2, replicated_head_id=$2 WHERE id=$1", [
      orb.id,
      record.id,
    ]);
    await query("DELETE FROM schema_migrations WHERE name=$1", [migration]);
    (await subject.database.migrate())._unsafeUnwrap();
  });
  afterEach(async () => {
    await subject.database.close();
  });

  it("migrates existing data and retains object, null-pair and relational constraints", async () => {
    expect(
      (
        await query(
          "SELECT pg_typeof(record)::text AS record_type, pg_typeof(harness_session_header)::text AS session_type FROM history_records JOIN orbs ON orbs.id=orb_id",
        )
      ).rows[0],
    ).toEqual({ record_type: "text", session_type: "text" });
    expect(await snapshot()).toEqual(initial);
    for (const payload of ["[]", "null", '"scalar"', "{"]) {
      for (const sql of [
        "UPDATE history_records SET record=$2 WHERE orb_id=$1",
        "UPDATE orbs SET harness_session_header=$2 WHERE id=$1",
      ])
        expect((await subject.client.query(sql, [orb.id, payload])).isErr()).toBe(true);
    }
    for (const sql of [
      "UPDATE orbs SET harness_session_header=NULL WHERE id=$1",
      "UPDATE orbs SET replication_cursor='missing' WHERE id=$1",
      "UPDATE history_records SET parent_id='missing' WHERE orb_id=$1",
    ])
      expect((await subject.client.query(sql, [orb.id])).isErr()).toBe(true);
    expect((await subject.database.migrate())._unsafeUnwrap()).toEqual([]);
  });

  it("rolls back Unicode records, receipts and cursor on deferred FK failure, preserving FIFO", async () => {
    const store = subject.database.store;
    const one = randomUUID(),
      two = randomUUID();
    const enqueue = async (messageId: string, now: number) =>
      (
        await store.enqueueOrbMessage(task, {
          orbId: orb.id,
          messageId,
          content: [{ type: "text", text: messageId }],
          now,
        })
      )._unsafeUnwrap();
    await enqueue(one, 1);
    const batch = (
      await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 2 })
    )._unsafeUnwrap();
    await enqueue(two, 3);
    const receipt: HistoryRecord = {
      ...record,
      id: "receipt",
      parentId: record.id,
      inboxMessageIds: [one],
      content: [{ type: "text", text: "\u0000\ud800" }],
      overflow: { native: { "\udfff": "\u0000" } },
    };
    const failed = await store.commitPullBatch(task, {
      orbId: orb.id,
      expectedCursor: record.id,
      session,
      records: [receipt],
      nextCursor: receipt.id,
      nextHeadId: "missing",
    });
    expect(failed.isErr() && failed.error).toMatchObject({
      type: "replication_integrity",
      reason: "mapping_failure",
      message: expect.stringContaining("orbs_replicated_head_fk"),
    });
    expect(await snapshot()).toEqual(initial);
    expect(
      (await store.readHistoryRecord(task, orb.id, session.id, receipt.id))._unsafeUnwrap(),
    ).toBeNull();
    expect(
      (await store.listOrbMessages(task, orb.id))._unsafeUnwrap().map((m) => m.status),
    ).toEqual(["delivering", "queued"]);
    expect(
      (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 4 }))._unsafeUnwrap(),
    ).toEqual(batch);
    (await commit([receipt]))._unsafeUnwrap();
    expect(
      (await store.listOrbMessages(task, orb.id))._unsafeUnwrap().map((m) => m.status),
    ).toEqual(["delivered", "queued"]);
    expect((await snapshot()).cursor).toBe(receipt.id);
    expect(
      (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 5 }))
        ._unsafeUnwrap()
        ?.map((m) => m.messageId),
    ).toEqual([two]);
  });

  it("isolates corrupt session metadata and preserves the affected orb's failure CAS", async () => {
    const store = subject.database.store;
    const healthy = makeOrbRow(randomUUID(), project.id, "running");
    (await store.insertOrb(task, healthy))._unsafeUnwrap();
    const broken = { id: "wrong", overflow: "invalid" };
    await query("UPDATE orbs SET harness_session_header=$2 WHERE id=$1", [
      orb.id,
      JSON.stringify(broken),
    ]);
    expect((await store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionHeader).toEqual(
      broken,
    );
    expect(
      (await store.listOrbsByProject(task, project.id))._unsafeUnwrap().map((row) => row.id),
    ).toEqual(expect.arrayContaining([orb.id, healthy.id]));
    expect((await store.listOrbsInStates(task, ["running"]))._unsafeUnwrap()).toHaveLength(2);
    const verified = await store.initOrVerifySession(task, orb.id, session);
    expect(verified.isErr() && verified.error).toMatchObject({
      type: "replication_integrity",
      reason: "mapping_failure",
    });
    if (verified.isOk() || verified.error.type !== "replication_integrity") return;
    expect(
      await failOrbForIntegrity(task, { ...makeHarness().deps, store }, orb.id, verified.error, 1),
    ).toBe(true);
    const failed = (await store.getOrb(task, orb.id))._unsafeUnwrap();
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).toContain("replication_integrity: mapping_failure:");
    expect((await store.getOrb(task, healthy.id))._unsafeUnwrap()?.state).toBe("running");
  });

  it("returns typed boundary errors for serialization and stored identity mismatches", async () => {
    const cycle: HistoryRecord["overflow"] = {};
    cycle["cycle"] = cycle;
    const encoded = await commit([{ ...record, overflow: cycle }]);
    expect(encoded.isErr() && encoded.error).toMatchObject({
      type: "replication_integrity",
      reason: "mapping_failure",
    });
    for (const changed of [
      { ...record, parentId: "wrong" },
      { ...record, id: "wrong" },
    ]) {
      await query("UPDATE history_records SET record=$2 WHERE orb_id=$1", [
        orb.id,
        JSON.stringify(changed),
      ]);
      const read = await subject.database.store.readHistoryRecord(
        task,
        orb.id,
        session.id,
        record.id,
      );
      expect(read.isErr() && read.error).toMatchObject(boundaryError);
    }
    await query("UPDATE orbs SET harness_session_header=$2 WHERE id=$1", [
      orb.id,
      JSON.stringify({ ...session, id: "wrong" }),
    ]);
    const read = await subject.database.store.readHistorySnapshot(task, orb.id);
    expect(read.isErr() && read.error).toMatchObject(boundaryError);
  });
});
