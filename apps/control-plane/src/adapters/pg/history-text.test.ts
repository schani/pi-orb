import { randomUUID } from "node:crypto";
import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOrbForIntegrity } from "../../domain/replication.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { openThrowawayPostgres } from "../../testkit/postgres.ts";
import type { StoreContractSubject } from "../../testkit/store-contract.ts";
import { composeControlPlaneDatabase } from "../database.ts";
import { jsonParam } from "./client.ts";
import { PGliteClient } from "./pglite-client.ts";

const task = new NoSimulationTask("history-text", false);
const migration = "044_lossless_history_json.sql";
const url = process.env["PI_ORB_TEST_DATABASE_URL"];
const drivers = ["PGlite", ...(url ? ["PostgreSQL"] : [])];

describe.each(drivers)("%s lossless history", (driver) => {
  let subject: StoreContractSubject;
  let project: ReturnType<typeof makeProjectRow>;
  let orb: ReturnType<typeof makeOrbRow>;
  const session: HarnessSessionMetadata = { id: "session", overflow: {} };
  const record: HistoryRecord = {
    id: "record",
    parentId: null,
    timestamp: "2026-10-13T00:00:00.000Z",
    type: "message",
    role: "tool",
    content: [{ type: "text", text: "safe" }],
    overflow: {},
  };

  beforeEach(async () => {
    if (driver === "PostgreSQL") subject = await openThrowawayPostgres(url ?? "");
    else {
      const client = new PGliteClient();
      subject = { client, database: composeControlPlaneDatabase(client) };
    }
    // Seed the last JSONB schema, then exercise the new migration over existing rows.
    (
      await subject.client.query(
        "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      )
    )._unsafeUnwrap();
    (
      await subject.client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration])
    )._unsafeUnwrap();
    (await subject.database.migrate())._unsafeUnwrap();
    project = makeProjectRow(randomUUID());
    orb = makeOrbRow(randomUUID(), project.id, "running");
    (
      await subject.database.users.resolveUser(
        task,
        { issuer: "test", subject: "owner", email: null },
        { id: project.ownerUserId, now: 0 },
      )
    )._unsafeUnwrap();
    (await subject.database.store.insertProject(task, project))._unsafeUnwrap();
    (await subject.database.store.insertOrb(task, orb))._unsafeUnwrap();
    (
      await subject.client.query(
        "UPDATE orbs SET harness_session_id=$2, harness_session_header=$3::jsonb WHERE id=$1",
        [orb.id, session.id, jsonParam(session)],
      )
    )._unsafeUnwrap();
    (
      await subject.client.query(
        "INSERT INTO history_records (orb_id,record_id,parent_id,record) VALUES ($1,$2,NULL,$3::jsonb)",
        [orb.id, record.id, jsonParam(record)],
      )
    )._unsafeUnwrap();
    (
      await subject.client.query(
        "UPDATE orbs SET replication_cursor=$2, replicated_head_id=$2 WHERE id=$1",
        [orb.id, record.id],
      )
    )._unsafeUnwrap();
    (
      await subject.client.query("DELETE FROM schema_migrations WHERE name=$1", [migration])
    )._unsafeUnwrap();
    (await subject.database.migrate())._unsafeUnwrap();
  });

  afterEach(async () => {
    await subject.database.close();
  });

  it("migrates existing data, preserves FKs and checks object shape without Unicode extraction", async () => {
    const types = (
      await subject.client.query(
        "SELECT pg_typeof(record)::text AS record_type, pg_typeof(harness_session_header)::text AS session_type FROM history_records JOIN orbs ON orbs.id=orb_id",
      )
    )._unsafeUnwrap().rows[0];
    expect(types).toEqual({ record_type: "text", session_type: "text" });
    expect(
      (await subject.database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap(),
    ).toEqual({ session, cursor: record.id, headId: record.id, records: [record] });
    for (const payload of ["[]", "null", '"scalar"', "{"]) {
      expect(
        (
          await subject.client.query("UPDATE history_records SET record=$2 WHERE orb_id=$1", [
            orb.id,
            payload,
          ])
        ).isErr(),
      ).toBe(true);
      expect(
        (
          await subject.client.query("UPDATE orbs SET harness_session_header=$2 WHERE id=$1", [
            orb.id,
            payload,
          ])
        ).isErr(),
      ).toBe(true);
    }
    expect(
      (
        await subject.client.query("UPDATE orbs SET harness_session_header=NULL WHERE id=$1", [
          orb.id,
        ])
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await subject.client.query("UPDATE orbs SET replication_cursor='missing' WHERE id=$1", [
          orb.id,
        ])
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await subject.client.query(
          "UPDATE history_records SET parent_id='missing' WHERE orb_id=$1",
          [orb.id],
        )
      ).isErr(),
    ).toBe(true);
    expect((await subject.database.migrate())._unsafeUnwrap()).toEqual([]);
  });

  it.each(["\u0000", "\ud800", "\udfff", "\\u0000", "\ud83d\ude00"])(
    "round-trips normalized/native/session values and nested keys %j",
    async (text) => {
      const special: HistoryRecord = {
        ...record,
        id: "special",
        parentId: record.id,
        content: [{ type: "text", text }],
        overflow: { native: { message: { content: text, details: { [text]: { [text]: text } } } } },
      };
      const specialSession = { ...session, overflow: { [text]: { value: text } } };
      // Empty replica session rotation remains permitted.
      (
        await subject.client.query(
          "UPDATE orbs SET replication_cursor=NULL, replicated_head_id=NULL WHERE id=$1",
          [orb.id],
        )
      )._unsafeUnwrap();
      (
        await subject.database.store.initOrVerifySession(task, orb.id, specialSession)
      )._unsafeUnwrap();
      const params = {
        orbId: orb.id,
        expectedCursor: null,
        session: specialSession,
        records: [special],
        nextCursor: special.id,
        nextHeadId: special.id,
      };
      const original = JSON.stringify({ special, specialSession });
      const committed = await subject.database.store.commitPullBatch(task, params);
      expect(committed.isOk(), committed.isErr() ? JSON.stringify(committed.error) : "").toBe(true);
      expect(JSON.stringify({ special, specialSession })).toBe(original);
      expect(
        (await subject.database.store.getOrb(task, orb.id))._unsafeUnwrap()?.harnessSessionHeader,
      ).toEqual(specialSession);
      expect(
        (
          await subject.database.store.readHistoryRecord(task, orb.id, session.id, special.id)
        )._unsafeUnwrap(),
      ).toEqual(special);
      expect(
        (await subject.database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap(),
      ).toEqual({
        session: specialSession,
        cursor: special.id,
        headId: special.id,
        records: [record, special],
      });
      // Property order is not immutable identity.
      const reordered = {
        ...special,
        overflow: { native: { message: { details: { [text]: { [text]: text } }, content: text } } },
      };
      (
        await subject.database.store.commitPullBatch(task, {
          ...params,
          expectedCursor: special.id,
          records: [reordered],
        })
      )._unsafeUnwrap();
      const conflict = await subject.database.store.commitPullBatch(task, {
        ...params,
        expectedCursor: special.id,
        records: [{ ...special, content: [{ type: "text", text: "replacement" }] }],
      });
      expect(conflict.isErr() && conflict.error).toMatchObject({
        type: "replication_integrity",
        reason: "record_conflict",
      });
      const sessionConflict = await subject.database.store.initOrVerifySession(task, orb.id, {
        ...specialSession,
        overflow: {},
      });
      expect(sessionConflict.isErr() && sessionConflict.error).toMatchObject({
        type: "replication_integrity",
        reason: "session_mismatch",
      });
    },
  );

  it.each(["\u0000", "\ud800", "\udfff"])(
    "stores record-only Unicode %j with a safe session",
    async (text) => {
      const variants: HistoryRecord[] = [
        { ...record, id: "normalized", parentId: record.id, content: [{ type: "text", text }] },
        {
          ...record,
          id: "native",
          parentId: "normalized",
          overflow: { native: { message: { content: text, details: { [text]: text } } } },
        },
      ];
      const result = await subject.database.store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: record.id,
        session,
        records: variants,
        nextCursor: "native",
        nextHeadId: "native",
      });
      expect(result.isOk(), result.isErr() ? JSON.stringify(result.error) : "").toBe(true);
      expect(
        (await subject.database.store.readHistorySnapshot(task, orb.id))._unsafeUnwrap(),
      ).toEqual({ session, cursor: "native", headId: "native", records: [record, ...variants] });
    },
  );

  it("rolls back Unicode records, receipts and cursor together, then admits the next queued batch", async () => {
    const store = subject.database.store;
    const one = randomUUID();
    const two = randomUUID();
    (
      await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId: one,
        content: [{ type: "text", text: "one" }],
        now: 1,
      })
    )._unsafeUnwrap();
    const batch = (
      await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 2 })
    )._unsafeUnwrap();
    (
      await store.enqueueOrbMessage(task, {
        orbId: orb.id,
        messageId: two,
        content: [{ type: "text", text: "two" }],
        now: 3,
      })
    )._unsafeUnwrap();
    const receipt: HistoryRecord = {
      ...record,
      id: "receipt",
      parentId: record.id,
      inboxMessageIds: [one],
      content: [{ type: "text", text: "\u0000\ud800" }],
      overflow: { native: { "\u0000\udfff": "kept" } },
    };
    const params = {
      orbId: orb.id,
      expectedCursor: record.id,
      session,
      records: [receipt],
      nextCursor: receipt.id,
      nextHeadId: receipt.id,
    };
    const failed = await store.commitPullBatch(task, { ...params, nextHeadId: "missing" });
    expect(failed.isErr() && failed.error).toMatchObject({
      type: "replication_integrity",
      reason: "mapping_failure",
      message: expect.stringContaining("orbs_replicated_head_fk"),
    });
    expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap()).toEqual({
      session,
      cursor: record.id,
      headId: record.id,
      records: [record],
    });
    expect(
      (await store.readHistoryRecord(task, orb.id, session.id, receipt.id))._unsafeUnwrap(),
    ).toBeNull();
    expect(
      (await store.listOrbMessages(task, orb.id))._unsafeUnwrap().map((m) => m.status),
    ).toEqual(["delivering", "queued"]);
    expect(
      (await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 4 }))._unsafeUnwrap(),
    ).toEqual(batch);
    (await store.commitPullBatch(task, params))._unsafeUnwrap();
    expect(
      (await store.listOrbMessages(task, orb.id))._unsafeUnwrap().map((m) => m.status),
    ).toEqual(["delivered", "queued"]);
    expect((await store.readHistorySnapshot(task, orb.id))._unsafeUnwrap().cursor).toBe(receipt.id);
    const next = (
      await store.claimNextOrbMessageBatch(task, { orbId: orb.id, now: 5 })
    )._unsafeUnwrap();
    expect(next?.map((m) => m.messageId)).toEqual([two]);
  });

  it("acknowledges an alert with Unicode elsewhere without SQL extraction", async () => {
    const alert: HistoryRecord = {
      id: "alert",
      parentId: record.id,
      timestamp: record.timestamp,
      type: "event",
      eventType: "pi.custom",
      alert: { message: "notice", requestId: "request" },
      content: [{ type: "text", text: "\u0000\ud800" }],
      overflow: { "\udfff": "\u0000" },
    };
    (
      await subject.database.store.commitPullBatch(task, {
        orbId: orb.id,
        expectedCursor: record.id,
        session,
        records: [alert],
        nextCursor: alert.id,
        nextHeadId: alert.id,
      })
    )._unsafeUnwrap();
    expect(
      (await subject.database.store.ackOrbAlert(task, orb.id, alert.id))._unsafeUnwrap(),
    ).toBeNull();
  });

  it("isolates invalid session metadata while retaining the affected orb's failure CAS", async () => {
    const store = subject.database.store;
    const healthy = makeOrbRow(randomUUID(), project.id, "running");
    (await store.insertOrb(task, healthy))._unsafeUnwrap();
    const broken = { id: "wrong", overflow: "invalid" };
    (
      await subject.client.query("UPDATE orbs SET harness_session_header=$2 WHERE id=$1", [
        orb.id,
        JSON.stringify(broken),
      ])
    )._unsafeUnwrap();
    const affected = (await store.getOrb(task, orb.id))._unsafeUnwrap();
    expect(affected?.harnessSessionHeader).toEqual(broken);
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

  it("returns typed errors for invalid shapes and decoded identity mismatches", async () => {
    const store = subject.database.store;
    const invalid = { ...record, id: "invalid", role: "invalid" } as unknown as HistoryRecord;
    const result = await store.commitPullBatch(task, {
      orbId: orb.id,
      expectedCursor: record.id,
      session,
      records: [invalid],
      nextCursor: invalid.id,
      nextHeadId: invalid.id,
    });
    expect(result.isErr() && result.error).toMatchObject({
      type: "replication_integrity",
      reason: "mapping_failure",
    });
    (
      await subject.client.query("UPDATE history_records SET record=$2 WHERE orb_id=$1", [
        orb.id,
        JSON.stringify({ ...record, parentId: "wrong" }),
      ])
    )._unsafeUnwrap();
    const parent = await store.readHistoryRecord(task, orb.id, session.id, record.id);
    expect(parent.isErr() && parent.error).toMatchObject({
      type: "store_error",
      code: "invariant",
      retryable: false,
    });
    (
      await subject.client.query("UPDATE history_records SET record=$2 WHERE orb_id=$1", [
        orb.id,
        JSON.stringify({ ...record, id: "wrong" }),
      ])
    )._unsafeUnwrap();
    const read = await store.readHistoryRecord(task, orb.id, session.id, record.id);
    expect(read.isErr() && read.error).toMatchObject({
      type: "store_error",
      code: "invariant",
      retryable: false,
    });
    (
      await subject.client.query("UPDATE orbs SET harness_session_header=$2 WHERE id=$1", [
        orb.id,
        JSON.stringify({ ...session, id: "wrong" }),
      ])
    )._unsafeUnwrap();
    const header = await store.readHistorySnapshot(task, orb.id);
    expect(header.isErr() && header.error).toMatchObject({
      type: "store_error",
      code: "invariant",
      retryable: false,
    });
  });
});
