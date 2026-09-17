import type { HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ControlPlaneDatabase, composeControlPlaneDatabase } from "../adapters/database.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { makeOrbRow, makeProjectRow, seedTestUser } from "../testkit/fixtures.ts";
import { InMemoryControlPlaneStore } from "../testkit/store.ts";
import type { ControlPlaneStore } from "./ports.ts";

const task = new NoSimulationTask("orb sleep matrix store", false);
const PROJECT = "00000000-0000-4000-8000-000000000081";
const ORB = "00000000-0000-4000-8000-000000000082";
const WAKE = "00000000-0000-4000-8000-000000000083";
const FIRST = "00000000-0000-4000-8000-000000000084";
const LAST = "00000000-0000-4000-8000-000000000085";

type Subject = { store: ControlPlaneStore; close: () => Promise<void> };

function contract(name: string, open: () => Promise<Subject>): void {
  describe(`${name} scheduled sleep FIFO matrix`, () => {
    let subject: Subject;

    beforeEach(async () => {
      subject = await open();
      expect((await subject.store.insertProject(task, makeProjectRow(PROJECT))).isOk()).toBe(true);
      expect(
        (
          await subject.store.insertOrb(
            task,
            makeOrbRow(ORB, PROJECT, "running", {
              runtimeTokenHash: "caller",
              hostIncarnation: 2,
            }),
          )
        ).isOk(),
      ).toBe(true);
    });

    afterEach(async () => subject.close());

    it("freezes human -> sleep_wake -> human at the source FIFO head", async () => {
      const store = subject.store;
      const firstContent = [{ type: "text" as const, text: "older human" }];
      expect(
        (
          await store.enqueueOrbMessage(task, {
            orbId: ORB,
            messageId: FIRST,
            content: firstContent,
            now: 1,
          })
        ).isOk(),
      ).toBe(true);
      const scheduled = await store.scheduleOrbSleep(task, {
        orbId: ORB,
        caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
        sleepId: WAKE,
        durationSeconds: 1,
      });
      expect(scheduled.isOk()).toBe(true);
      const deadline = scheduled._unsafeUnwrap().sleepUntil;
      expect(deadline).not.toBeNull();
      if (deadline === null) throw new Error("scheduled sleep deadline missing");
      const stopped = await store.casTransition(task, {
        orbId: ORB,
        expectedStateVersion: 1,
        toState: "stopped",
        now: 2,
      });
      expect(stopped.isOk()).toBe(true);
      expect(
        (
          await store.processDueOrbSleep(task, {
            orbId: ORB,
            sleepId: WAKE,
            expectedStateVersion: 2,
            now: deadline,
          })
        )._unsafeUnwrap(),
      ).toBe("wake");
      expect(
        (
          await store.enqueueOrbMessage(task, {
            orbId: ORB,
            messageId: LAST,
            content: [{ type: "text", text: "later human" }],
            now: 1_002,
          })
        ).isOk(),
      ).toBe(true);

      expect(
        (
          await store.casStartOrbForQueuedMessage(task, {
            orbId: ORB,
            expectedStateVersion: 3,
            now: 1_003,
          })
        ).isOk(),
      ).toBe(true);
      const bootCaller = { runtimeTokenHash: "caller", hostIncarnation: 2 };
      expect(
        (
          await store.readOrbBootContext(task, {
            orbId: ORB,
            caller: bootCaller,
          })
        )._unsafeUnwrap(),
      ).toBeNull();
      expect(
        (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 1_003 }))
          ._unsafeUnwrap()
          .map((row) => row.messageId),
      ).toEqual([FIRST]);
      expect(
        (
          await store.readOrbBootContext(task, {
            orbId: ORB,
            caller: bootCaller,
          })
        )._unsafeUnwrap(),
      ).toBeNull();

      const firstRecord: HistoryRecord = {
        id: "first-human-record",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "message",
        role: "user",
        content: firstContent,
        inboxMessageIds: [FIRST],
        overflow: {},
      };
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: ORB,
            expectedCursor: null,
            session: { id: "session", overflow: {} },
            records: [firstRecord],
            nextCursor: firstRecord.id,
            nextHeadId: firstRecord.id,
          })
        ).isOk(),
      ).toBe(true);

      const context = (
        await store.readOrbBootContext(task, { orbId: ORB, caller: bootCaller })
      )._unsafeUnwrap();
      expect(context).toMatchObject({ messageId: WAKE, messageIds: [WAKE] });
      expect(
        (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 1_004 }))
          ._unsafeUnwrap()
          .map((row) => row.messageId),
      ).toEqual([WAKE]);

      const wakeRecord: HistoryRecord = {
        id: "sleep-wake-record",
        parentId: firstRecord.id,
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event",
        eventType: "pi.custom_message",
        content: [{ type: "text", text: "Scheduled sleep finished." }],
        custom: { customType: "pi-orb.sleep-wake", display: true },
        inboxMessageIds: [WAKE],
        overflow: {},
      };
      expect(
        (
          await store.commitPullBatch(task, {
            orbId: ORB,
            expectedCursor: firstRecord.id,
            session: { id: "session", overflow: {} },
            records: [wakeRecord],
            nextCursor: wakeRecord.id,
            nextHeadId: wakeRecord.id,
          })
        ).isOk(),
      ).toBe(true);
      expect(
        (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 1_005 }))
          ._unsafeUnwrap()
          .map((row) => row.messageId),
      ).toEqual([LAST]);
    });
  });
}

contract("in-memory", async () => ({
  store: new InMemoryControlPlaneStore(),
  close: async () => undefined,
}));

contract("PGlite", async () => {
  const database: ControlPlaneDatabase = composeControlPlaneDatabase(new PGliteClient());
  expect((await database.migrate()).isOk()).toBe(true);
  expect((await seedTestUser(task, database.users)).isOk()).toBe(true);
  return {
    store: database.store,
    close: async () => void (await database.close()),
  };
});
