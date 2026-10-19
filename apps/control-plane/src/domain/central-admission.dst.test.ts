import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { createCentralOrbAgentOperations } from "./orb-agent-operations.ts";
import type { CentralAgentCaller } from "./ports.ts";

const caller: CentralAgentCaller = {
  kind: "central",
  ownerUserId: "owner",
  projectId: "project",
  orbId: "orb",
  agentAdmissionVersion: 0,
};

describe("central admission transaction fence", () => {
  it("pending sleep preserves admitted CP continuation but rejects new work", async () => {
    await runDst({ name: "central-pending-sleep-continuation", iterations: 10 }, async (sim) => {
      const h = makeHarness();
      let alerts = 0;
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
            h.store.seedOrb(
              makeOrbRow("orb", "project", "running", {
                sleepId: "sleep",
                sleepUntil: task.wallNow() + 60_000,
              }),
            );
            const service = createCentralOrbAgentOperations(task, h.deps, caller, {
              appOrigin: "http://app",
              appendAlert: () => {
                alerts++;
                return okAsync({ recordId: "alert" });
              },
            });
            for (const request of [
              { kind: "self" },
              { kind: "list" },
              { kind: "alert", message: "done" },
            ] as const)
              expect((await service.invoke(request, request.kind)).isOk()).toBe(true);
            expect(alerts).toBe(1);
            expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(0);
            expect(
              (
                await h.store.spawnOrb(task, {
                  callerOrbId: "orb",
                  caller,
                  orb: makeOrbRow("child", "project", "creating"),
                  prompt: "work",
                  requestHash: "hash",
                })
              )._unsafeUnwrapErr(),
            ).toMatchObject({ type: "spawn_conflict", reason: "unauthorized" });
            const row = h.store.orbSnapshot("orb")!;
            for (const operation of [
              h.store.requestOrbArchive.bind(h.store),
              h.store.requestOrbDeletion.bind(h.store),
            ])
              expect(
                (
                  await operation(task, {
                    orbId: "orb",
                    caller,
                    expectedStateVersion: row.stateVersion,
                    now: task.wallNow(),
                    cleanupAfter: task.wallNow(),
                  })
                )._unsafeUnwrapErr(),
              ).toMatchObject({ type: "state_conflict" });
            // The timer's clearing sleepId cannot revive a genuinely sleeping caller.
            h.store.seedOrb({ ...row, sleepId: null, sleepUntil: null, stopReason: "sleep" });
            expect((await service.invoke({ kind: "self" }, "stopped")).isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  it("seals central archive with no VM or guest restoration", async () => {
    await runDst({ name: "central-archive-offline", iterations: 5 }, async (sim) => {
      const h = makeHarness();
      let suspended = 0;
      const operations: string[] = [];
      const plane: AgentPlane = {
        placement: "central",
        health: () =>
          okAsync({
            v: 1 as const,
            orbId: "orb",
            runtimeInstanceId: "central",
            status: "initializing" as const,
            phase: "booting" as const,
          }),
        deliverMessage: () =>
          okAsync({
            v: 1 as const,
            messageId: "m",
            status: "persisted" as const,
            delivery: "turn" as const,
            operationId: "turn",
            duplicate: false,
          }),
        prepareIdleStop: () => {
          operations.push("prepare");
          return okAsync({ v: 1 as const, prepared: true });
        },
        pullHistory: () => {
          operations.push("pull");
          return okAsync({
            v: 1 as const,
            orbId: "orb",
            runtimeInstanceId: "central",
            session: { id: "durable", overflow: {} },
            records: [],
            cursor: null,
            headId: null,
            activity: "idle" as const,
          });
        },
        suspend: () => {
          operations.push("suspend");
          suspended++;
          return okAsync(undefined);
        },
        dispose: () => okAsync(undefined),
        session: () => null,
        close: () => okAsync(undefined),
      };
      const deps = { ...h.deps, agentPlane: plane };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
            h.store.seedOrb(
              makeOrbRow("orb", "project", "failed", {
                checkoutCommit: "old",
                harnessSessionId: "durable",
              }),
            );
            expect(
              (
                await h.store.requestOrbArchive(task, {
                  orbId: "orb",
                  caller,
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            await reconcileOrbOnce(task, deps, "orb");
            expect(h.store.deletionSnapshot("orb")).toMatchObject({
              historySealedAt: expect.any(Number),
            });
            expect(h.world.hostCount("orb")).toBe(0);
            expect(suspended).toBe(2);
            expect(operations).toEqual(["prepare", "suspend", "pull", "suspend"]);
          },
        },
      ]);
      expect(
        result.isOk(),
        `suspensions=${suspended}; intent=${JSON.stringify(h.store.deletionSnapshot("orb"))}`,
      ).toBe(true);
    });
  });
  it("denies stale spawn/sleep/archive/delete after Stop then Start", async () => {
    await runDst({ name: "central-admission-aba", iterations: 15 }, async (sim) => {
      const h = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
            h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
            expect((await requestOrbStop(task, h.deps, "orb")).isOk()).toBe(true);
            expect((await requestOrbStart(task, h.deps, "orb")).isOk()).toBe(true);
            const row = h.store.orbSnapshot("orb")!;
            expect(row.stopReason).toBeNull();
            expect(
              (
                await h.store.spawnOrb(task, {
                  callerOrbId: "orb",
                  caller,
                  orb: makeOrbRow("child", "project", "creating"),
                  prompt: "hello",
                  requestHash: "hash",
                })
              ).isErr(),
            ).toBe(true);
            expect(
              (
                await h.store.scheduleOrbSleep(task, {
                  orbId: "orb",
                  caller,
                  sleepId: "sleep",
                  durationSeconds: 60,
                })
              ).isErr(),
            ).toBe(true);
            for (const operation of [
              h.store.requestOrbArchive.bind(h.store),
              h.store.requestOrbDeletion.bind(h.store),
            ]) {
              expect(
                (
                  await operation(task, {
                    orbId: "orb",
                    caller,
                    expectedStateVersion: row.stateVersion,
                    now: task.wallNow(),
                    cleanupAfter: task.wallNow(),
                  })
                ).isErr(),
              ).toBe(true);
            }
            expect(h.store.orbSnapshot("child")).toBeNull();
            expect(h.store.orbSnapshot("orb")?.state).toBe("starting");
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
  it("graceful self archive closes new admission without revoking the admitted continuation", async () => {
    await runDst({ name: "central-graceful-authority", iterations: 10 }, async (sim) => {
      const h = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
            h.store.seedOrb(makeOrbRow("orb", "project", "failed"));
            expect(
              (
                await h.store.requestOrbArchive(task, {
                  orbId: "orb",
                  caller,
                  expectedStateVersion: 0,
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(0);
            expect(
              (
                await h.store.scheduleOrbSleep(task, {
                  orbId: "orb",
                  caller,
                  sleepId: "sleep",
                  durationSeconds: 60,
                })
              ).isErr(),
            ).toBe(true);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
});
