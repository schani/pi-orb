import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControlPlaneDatabase, composeControlPlaneDatabase } from "../adapters/database.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../testkit/fixtures.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";
import type { ControlPlaneStore } from "./ports.ts";

const task = new NoSimulationTask("orb sleep integration store", false);
const PROJECT = "00000000-0000-4000-8000-000000000061";
const ORB = "00000000-0000-4000-8000-000000000062";
const SLEEP = "00000000-0000-4000-8000-000000000063";
const DEADLINE = 10_000;

type Subject = { store: ControlPlaneStore; close: () => Promise<void> };

function contract(name: string, open: () => Promise<Subject>): void {
  describe(`${name} scheduled sleep replication`, () => {
    let subject: Subject;

    beforeEach(async () => {
      subject = await open();
      expect((await subject.store.insertProject(task, makeProjectRow(PROJECT))).isOk()).toBe(true);
      expect(
        (
          await subject.store.insertOrb(
            task,
            makeOrbRow(ORB, PROJECT, "stopped", {
              sleepId: SLEEP,
              sleepUntil: DEADLINE,
            }),
          )
        ).isOk(),
      ).toBe(true);
    });

    afterEach(async () => subject.close());

    it("atomically cancels stopped sleep and returns the fresh row with its identity", async () => {
      const stopped = await subject.store.requestOrbStop(task, {
        orbId: ORB,
        expectedStateVersion: 0,
        now: DEADLINE,
      });
      expect(stopped._unsafeUnwrap()).toMatchObject({
        cancelledSleepId: SLEEP,
        orb: { state: "stopped", sleepId: null, sleepUntil: null, stateVersion: 1 },
      });
    });

    it("turns a graceful sleep stop into one fresh explicit stop episode", async () => {
      const sleeping = await subject.store.casTransition(task, {
        orbId: ORB,
        expectedStateVersion: 0,
        toState: "stopping",
        stopReason: "sleep",
        now: 2_000,
      });
      expect(sleeping.isOk()).toBe(true);

      const overridden = await subject.store.requestOrbStop(task, {
        orbId: ORB,
        expectedStateVersion: 1,
        now: DEADLINE,
      });
      expect(overridden._unsafeUnwrap()).toMatchObject({
        cancelledSleepId: SLEEP,
        orb: {
          state: "stopping",
          stopReason: null,
          sleepId: null,
          sleepUntil: null,
          stateVersion: 2,
          stateChangedAt: DEADLINE,
        },
      });

      const repeated = await subject.store.requestOrbStop(task, {
        orbId: ORB,
        expectedStateVersion: 2,
        now: DEADLINE + 5_000,
      });
      expect(repeated._unsafeUnwrap()).toMatchObject({
        cancelledSleepId: null,
        orb: {
          state: "stopping",
          stopReason: null,
          sleepId: null,
          sleepUntil: null,
          stateVersion: 2,
          stateChangedAt: DEADLINE,
        },
      });
    });

    it("keeps an explicit stop idempotent after cancelling its sleep timer", async () => {
      const sleeping = await subject.store.casTransition(task, {
        orbId: ORB,
        expectedStateVersion: 0,
        toState: "stopping",
        stopReason: "sleep",
        now: 2_000,
      });
      expect(sleeping.isOk()).toBe(true);
      expect(
        (
          await subject.store.requestOrbStop(task, {
            orbId: ORB,
            expectedStateVersion: 1,
            now: 2_500,
          })
        ).isOk(),
      ).toBe(true);

      expect(
        (
          await subject.store.requestOrbStop(task, {
            orbId: ORB,
            expectedStateVersion: 2,
            now: DEADLINE,
          })
        )._unsafeUnwrap(),
      ).toMatchObject({
        cancelledSleepId: null,
        orb: {
          state: "stopping",
          stopReason: null,
          sleepId: null,
          sleepUntil: null,
          stateVersion: 2,
          stateChangedAt: 2_500,
        },
      });
    });

    it("preserves a due wake notice while Stop revokes its authority with the sleep identity", async () => {
      expect(
        (
          await subject.store.processDueOrbSleep(task, {
            orbId: ORB,
            sleepId: SLEEP,
            expectedStateVersion: 0,
            now: DEADLINE,
          })
        )._unsafeUnwrap(),
      ).toBe("wake");
      expect(
        (
          await subject.store.requestOrbStop(task, {
            orbId: ORB,
            expectedStateVersion: 1,
            now: DEADLINE,
          })
        )._unsafeUnwrap(),
      ).toMatchObject({ cancelledSleepId: SLEEP, orb: { state: "stopped" } });
      expect((await subject.store.listOrbMessages(task, ORB))._unsafeUnwrap()[0]).toMatchObject({
        messageId: SLEEP,
        status: "queued",
        autoStart: false,
      });
    });

    it("rejects stale boot callers before freezing the wake notice", async () => {
      expect(
        (
          await subject.store.processDueOrbSleep(task, {
            orbId: ORB,
            sleepId: SLEEP,
            expectedStateVersion: 0,
            now: DEADLINE,
          })
        )._unsafeUnwrap(),
      ).toBe("wake");
      expect(
        (
          await subject.store.casTransition(task, {
            orbId: ORB,
            expectedStateVersion: 1,
            toState: "starting",
            now: DEADLINE,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (
          await subject.store.readOrbBootContext(task, {
            orbId: ORB,
            caller: { runtimeTokenHash: "replaced", hostIncarnation: 1 },
          })
        ).isErr(),
      ).toBe(true);
      expect((await subject.store.listOrbMessages(task, ORB))._unsafeUnwrap()[0]).toMatchObject({
        status: "queued",
        deliveryBatchId: null,
      });
    });

    it("event inbox IDs acknowledge the wake notice and clear its authority", async () => {
      expect(
        (
          await subject.store.processDueOrbSleep(task, {
            orbId: ORB,
            sleepId: SLEEP,
            expectedStateVersion: 0,
            now: DEADLINE,
          })
        )._unsafeUnwrap(),
      ).toBe("wake");
      expect((await subject.store.listOrbMessages(task, ORB))._unsafeUnwrap()[0]).toMatchObject({
        status: "queued",
        autoStart: true,
        wakeStateVersion: 1,
      });

      const record: HistoryRecord = {
        id: "sleep-wake-event",
        parentId: null,
        timestamp: new Date(DEADLINE).toISOString(),
        type: "event",
        eventType: "pi.custom_message",
        content: [{ type: "text", text: "Scheduled sleep finished." }],
        custom: { customType: "pi-orb.sleep-wake", display: true },
        inboxMessageIds: [SLEEP],
        overflow: {},
      };
      const committed = await subject.store.commitPullBatch(task, {
        orbId: ORB,
        expectedCursor: null,
        session: { id: "sleep-session", overflow: {} },
        records: [record],
        nextCursor: record.id,
        nextHeadId: record.id,
      });
      expect(committed.isOk(), committed.isErr() ? JSON.stringify(committed.error) : "").toBe(true);
      expect((await subject.store.listOrbMessages(task, ORB))._unsafeUnwrap()[0]).toMatchObject({
        status: "delivered",
        autoStart: false,
        lastError: null,
      });
      expect((await subject.store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({
        sleepId: null,
        sleepUntil: null,
      });
    });
  });
}

contract("in-memory", async () => {
  const store = new InMemoryControlPlaneStore();
  return { store, close: async () => undefined };
});

contract("PGlite", async () => {
  const database: ControlPlaneDatabase = composeControlPlaneDatabase(new PGliteClient());
  expect((await database.migrate()).isOk()).toBe(true);
  expect((await seedTestUser(task, database.users)).isOk()).toBe(true);
  return { store: database.store, close: async () => void (await database.close()) };
});
