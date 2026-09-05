import { ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { ControlState } from "./control-state.ts";
import { requestOrbArchive, requestOrbDeletion, requestOrbStart } from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-archive";

describe("orb archival (DST)", () => {
  it.each(["stop", "replacement", "discard", "delete"] as const)(
    "revalidates self authority when %s wins the archive write",
    async (race) => {
      await runDst({ name: `self-archive-race-${race}`, iterations: 20 }, async (sim) => {
        const harness = makeHarness();
        let intercepted = false;
        const store = new Proxy(harness.store, {
          get(target, property, receiver) {
            if (property === "requestOrbArchive") {
              return (
                task: Parameters<typeof target.requestOrbArchive>[0],
                params: Parameters<typeof target.requestOrbArchive>[1],
              ) =>
                new ResultAsync(
                  (async () => {
                    await task.sleep(1, "self archive before fenced write");
                    if (!intercepted) {
                      intercepted = true;
                      const current = target.orbSnapshot(ORB);
                      if (current !== null) {
                        target.seedOrb({
                          ...current,
                          stateVersion: current.stateVersion + 1,
                          ...(race === "stop"
                            ? { state: "stopping" as const }
                            : race === "delete"
                              ? { state: "deleting" as const }
                              : race === "discard"
                                ? { hostDiscardThroughIncarnation: current.hostIncarnation }
                                : {
                                    hostIncarnation: current.hostIncarnation + 1,
                                    runtimeTokenHash: "replacement-token",
                                  }),
                        });
                      }
                    }
                    return await target.requestOrbArchive(task, params);
                  })(),
                );
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const result = await sim.runTasks([
          {
            name: "agent",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const orb = harness.store.orbSnapshot(ORB);
              const requested = await requestOrbArchive(task, { ...harness.deps, store }, ORB, {
                runtimeTokenHash: orb?.runtimeTokenHash ?? "",
                hostIncarnation: orb?.hostIncarnation ?? -1,
              });
              expect(requested.isErr() && requested.error.code).toBe("conflict");
              expect(harness.store.orbSnapshot(ORB)?.state).not.toBe("archiving");
              expect(harness.store.deletionSnapshot(ORB)).toBeNull();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      });
    },
  );

  it("self-archive returns while busy and retains the rest of the turn", async () => {
    await runDst({ name: "self-archive-busy-turn", iterations: 20 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const expected: string[] = [];
      let accepted = false;
      const restartedDeps = { ...harness.deps, control: new ControlState() };
      const result = await sim.runTasks([
        {
          name: "restarted reconciler",
          f: async (task) => {
            await waitUntil(task, "archive accepted before control-plane restart", () => accepted);
            await reconcileLoop(task, restartedDeps, stop.signal);
          },
        },
        {
          name: "agent",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            expected.push(harness.world.appendMessage(ORB, "Please archive this orb").id);
            const orb = harness.store.orbSnapshot(ORB);
            const caller = {
              runtimeTokenHash: orb?.runtimeTokenHash ?? "",
              hostIncarnation: orb?.hostIncarnation ?? -1,
            };
            expect((await requestOrbArchive(task, harness.deps, ORB, caller)).isOk()).toBe(true);
            expect((await requestOrbArchive(task, harness.deps, ORB, caller)).isOk()).toBe(true);
            accepted = true;
            await waitUntil(
              task,
              "archival observed busy turn",
              () => restartedDeps.control.getLiveness(ORB)?.activity === "busy",
            );
            expect(harness.store.deletionSnapshot(ORB)?.historySealedAt).toBeNull();
            expect(harness.world.filesystemExists(ORB)).toBe(true);
            expected.push(harness.world.appendMessage(ORB, "Archive requested (tool result)").id);
            expected.push(harness.world.appendMessage(ORB, "Final assistant reply").id);
            harness.world.setActivity(ORB, "idle");
            await waitUntil(
              task,
              "self archival complete",
              () => harness.store.orbSnapshot(ORB)?.state === "archived",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.replicaRecords(ORB).map((record) => record.id)).toEqual(expected);
      expect(harness.world.filesystemExists(ORB)).toBe(false);
    });
  });

  it("seals and retains history while destroying every runtime resource", async () => {
    await runDst({ name: "archive-complete", iterations: 20 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const expected: string[] = [];
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            expected.push(harness.world.appendMessage(ORB, "keep me").id);
            expected.push(harness.world.appendMessage(ORB, "kept reply").id);
            const requested = await requestOrbArchive(task, harness.deps, ORB);
            expect(requested.isOk() && requested.value.state).toBe("archiving");
            await waitUntil(
              task,
              "archive completed",
              () => harness.store.orbSnapshot(ORB)?.state === "archived",
              { timeoutMs: 120_000 },
            );
            expect((await requestOrbStart(task, harness.deps, ORB)).isErr()).toBe(true);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.world.hostCount(ORB)).toBe(0);
      expect(harness.world.filesystemExists(ORB)).toBe(false);
      expect(harness.store.replicaRecords(ORB).map((record) => record.id)).toEqual(expected);
      expect(harness.store.orbSnapshot(ORB)?.runtimeTokenHash).toBeNull();
      expect(harness.store.deletionSnapshot(ORB)).toBeNull();
    });
  });

  it("disposes failed compute, provisions a clean incarnation, then seals history", async () => {
    await runDst({ name: "archive-failed-compute", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      let archiveRequested = false;
      const expected: string[] = [];
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            while (!archiveRequested) await task.sleep(1, "wait for failed archive request");
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            expected.push(harness.world.appendMessage(ORB, "retain across failed compute").id);
            const running = harness.store.orbSnapshot(ORB);
            expect(running).not.toBeNull();
            if (running === null) return;
            const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              now: task.wallNow(),
              lastError: "runtime_failed: test failure",
            });
            expect(failed.isOk()).toBe(true);
            const requested = await requestOrbArchive(task, harness.deps, ORB);
            expect(requested.isOk() && requested.value).toMatchObject({
              state: "archiving",
              hostDiscardThroughIncarnation: 0,
            });
            archiveRequested = true;

            await waitUntil(
              task,
              "failed orb archived through clean compute",
              () => harness.store.orbSnapshot(ORB)?.state === "archived",
              { timeoutMs: 600_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.replicaRecords(ORB).map((record) => record.id)).toEqual(expected);
      expect(harness.store.orbSnapshot(ORB)).toMatchObject({
        state: "archived",
        hostIncarnation: 1,
        hostRef: null,
        runtimeTokenHash: null,
      });
      expect(harness.world.filesystemExists(ORB)).toBe(false);
    });
  });

  it("can be upgraded to permanent deletion while archiving", async () => {
    await runDst({ name: "archive-upgrade-delete", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.beginTurn(ORB);
            await requestOrbArchive(task, harness.deps, ORB);
            const deleted = await requestOrbDeletion(task, harness.deps, ORB);
            expect(deleted.isOk() && deleted.value.state).toBe("deleting");
            await waitUntil(
              task,
              "delete completed",
              () => harness.store.orbSnapshot(ORB) === null,
              {
                timeoutMs: 120_000,
              },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.replicaRecords(ORB)).toEqual([]);
    });
  });
});
