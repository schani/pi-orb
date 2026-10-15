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

    it.each(["stopped", "failed"] as const)(
      "old queued wake cannot supersede a preserved Sleep in %s, but fresh input can",
      async (terminalState) => {
        const store = subject.store;
        const transition = async (toState: "stopped" | "starting" | "running" | "failed") => {
          const orb = (await store.getOrb(task, ORB))._unsafeUnwrap();
          if (orb === null) throw new Error("seeded orb missing");
          return (
            await store.casTransition(task, {
              orbId: ORB,
              expectedStateVersion: orb.stateVersion,
              toState,
              now: 1,
            })
          )._unsafeUnwrap();
        };
        await transition("stopped");
        const old = (
          await store.enqueueOrbMessage(task, {
            orbId: ORB,
            messageId: FIRST,
            content: [{ type: "text", text: "old input" }],
            now: 2,
          })
        )._unsafeUnwrap();
        expect(old.message.autoStart).toBe(true);
        await transition("starting");
        await transition("running");
        const sleeping = (
          await store.scheduleOrbSleep(task, {
            orbId: ORB,
            caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
            sleepId: WAKE,
            durationSeconds: 300,
          })
        )._unsafeUnwrap();
        await transition(terminalState);
        const before = (await store.getOrb(task, ORB))._unsafeUnwrap();
        if (before === null || sleeping.sleepUntil === null)
          throw new Error("sleeping orb missing");
        for (const now of [sleeping.sleepUntil - 1, sleeping.sleepUntil + 1]) {
          expect(
            (
              await store.casStartOrbForQueuedMessage(task, {
                orbId: ORB,
                expectedStateVersion: before.stateVersion,
                now,
              })
            )._unsafeUnwrap(),
          ).toBeNull();
          expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toEqual(before);
        }
        const fresh = (
          await store.enqueueOrbMessage(task, {
            orbId: ORB,
            messageId: LAST,
            content: [{ type: "text", text: "fresh input" }],
            now: 3,
          })
        )._unsafeUnwrap();
        expect(fresh.orb.sleepId).toBeNull();
        expect(
          (
            await store.casStartOrbForQueuedMessage(task, {
              orbId: ORB,
              expectedStateVersion: fresh.orb.stateVersion,
              now: 4,
            })
          )._unsafeUnwrap(),
        ).toMatchObject({ state: "starting", sleepId: null });
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 5 }))
            ._unsafeUnwrap()
            .map((row) => row.messageId),
        ).toEqual([FIRST, LAST]);
      },
    );

    it.each([false, true])(
      "holds old input through Sleep until fresh peer admission (claimed=%s)",
      async (claimed) => {
        const store = subject.store;
        const senderId = "00000000-0000-4000-8000-000000000086";
        const project = (await store.getProject(task, PROJECT))._unsafeUnwrap();
        expect(project).not.toBeNull();
        if (project === null) throw new Error("seeded project missing");
        expect((await store.insertOrb(task, makeOrbRow(senderId, PROJECT, "running"))).isOk()).toBe(
          true,
        );
        const sender = {
          orbId: senderId,
          projectId: PROJECT,
          ownerUserId: project.ownerUserId,
          caller: {
            kind: "central" as const,
            orbId: senderId,
            projectId: PROJECT,
            ownerUserId: project.ownerUserId,
            agentAdmissionVersion: 0,
          },
        };
        const enqueue = (messageId: string) =>
          store.enqueueOrbMessage(task, {
            orbId: ORB,
            messageId,
            sender,
            content: [{ type: "text", text: messageId }],
            now: 1,
          });
        expect((await enqueue(FIRST)).isOk()).toBe(true);
        const humanId = "00000000-0000-4000-8000-000000000087";
        expect(
          (
            await store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: humanId,
              content: [{ type: "text", text: "later human" }],
              now: 2,
            })
          ).isOk(),
        ).toBe(true);
        if (claimed)
          expect(
            (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 2 }))
              ._unsafeUnwrap()
              .map((row) => row.messageId),
          ).toEqual([FIRST]);
        expect(
          (
            await store.scheduleOrbSleep(task, {
              orbId: ORB,
              caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
              sleepId: WAKE,
              durationSeconds: 300,
            })
          ).isOk(),
        ).toBe(true);
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 3 }))._unsafeUnwrap(),
        ).toEqual([]);
        expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({ sleepId: WAKE });
        expect((await enqueue(FIRST))._unsafeUnwrap().duplicate).toBe(true);
        expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({ sleepId: WAKE });
        expect((await enqueue(LAST))._unsafeUnwrap().duplicate).toBe(false);
        expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({
          sleepId: null,
          sleepUntil: null,
        });
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 4 }))
            ._unsafeUnwrap()
            .map((row) => row.messageId),
        ).toEqual([FIRST]);
        expect(
          (await store.listOrbMessages(task, ORB))._unsafeUnwrap().map((row) => row.system),
        ).toEqual([
          { kind: "orb_message", senderOrbId: senderId },
          null,
          { kind: "orb_message", senderOrbId: senderId },
        ]);
        const record: HistoryRecord = {
          id: "first-peer",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          overflow: {},
          type: "event",
          eventType: "orb.message",
          content: [{ type: "text", text: FIRST }],
          sender: { orbId: senderId },
          inboxMessageIds: [FIRST],
        };
        expect(
          (
            await store.commitPullBatch(task, {
              orbId: ORB,
              expectedCursor: null,
              session: { id: "session", overflow: {} },
              records: [record],
              nextCursor: record.id,
              nextHeadId: record.id,
            })
          ).isOk(),
        ).toBe(true);
        expect(
          (await store.claimNextOrbMessageBatch(task, { orbId: ORB, now: 5 }))
            ._unsafeUnwrap()
            .map((row) => row.messageId),
        ).toEqual([humanId]);
      },
    );

    it("fresh peer admission cancels Sleep, but later Sleep and Stop win", async () => {
      const store = subject.store;
      const peerId = "00000000-0000-4000-8000-000000000086";
      const project = (await store.getProject(task, PROJECT))._unsafeUnwrap();
      expect(project).not.toBeNull();
      if (project === null) throw new Error("seeded project missing");
      expect((await store.insertOrb(task, makeOrbRow(peerId, PROJECT, "running"))).isOk()).toBe(
        true,
      );
      const sleep = (sleepId: string) =>
        store.scheduleOrbSleep(task, {
          orbId: ORB,
          caller: { runtimeTokenHash: "caller", hostIncarnation: 2 },
          sleepId,
          durationSeconds: 300,
        });
      const send = () =>
        store.enqueueOrbMessage(task, {
          orbId: ORB,
          messageId: FIRST,
          now: 1,
          content: [{ type: "text", text: "peer" }],
          sender: {
            orbId: peerId,
            projectId: PROJECT,
            ownerUserId: project.ownerUserId,
            caller: {
              kind: "central",
              orbId: peerId,
              projectId: PROJECT,
              ownerUserId: project.ownerUserId,
              agentAdmissionVersion: 0,
            },
          },
        });
      expect((await sleep(WAKE)).isOk()).toBe(true);
      expect((await send())._unsafeUnwrap().duplicate).toBe(false);
      expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({
        sleepId: null,
        sleepUntil: null,
      });
      expect((await sleep(LAST)).isOk()).toBe(true);
      expect((await send())._unsafeUnwrap().duplicate).toBe(true);
      expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({ sleepId: LAST });
      const current = (await store.getOrb(task, ORB))._unsafeUnwrap();
      if (current === null) throw new Error("seeded orb missing");
      expect(
        (
          await store.requestOrbStop(task, {
            orbId: ORB,
            expectedStateVersion: current.stateVersion,
            now: 2,
          })
        ).isOk(),
      ).toBe(true);
      expect((await send())._unsafeUnwrap().duplicate).toBe(true);
      expect((await store.getOrb(task, ORB))._unsafeUnwrap()).toMatchObject({
        sleepId: null,
        stopReason: "manual",
      });
      expect((await store.listOrbMessages(task, ORB))._unsafeUnwrap()[0]).toMatchObject({
        autoStart: false,
        system: { kind: "orb_message", senderOrbId: peerId },
      });
    });

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
