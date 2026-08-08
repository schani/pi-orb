import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, restartControlPlane, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { requestOrbDeletion, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-delete";

describe("orb deletion (DST)", () => {
  it("removes host, authoritative filesystem, replica, row, and tombstone", async () => {
    await runDst({ name: "delete-complete", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            const deleted = await requestOrbDeletion(task, harness.deps, ORB);
            expect(deleted.isOk()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)?.state).toBe("deleting");
            expect((await requestOrbStart(task, harness.deps, ORB)).isErr()).toBe(true);
            expect((await requestOrbStop(task, harness.deps, ORB)).isErr()).toBe(true);
            await waitUntil(
              task,
              "orb fully deleted",
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
      expect(harness.world.hostCount(ORB)).toBe(0);
      expect(harness.world.filesystemExists(ORB)).toBe(false);
      expect(harness.store.replicaRecords(ORB)).toEqual([]);
      expect(harness.store.deletionSnapshot(ORB)).toBeNull();
    });
  });

  it("survives destroy/store failures and a control-plane restart", async () => {
    await runDst(
      {
        name: "delete-retries-after-restart",
        iterations: 30,
        failpointProbabilities: {
          [FAILPOINTS.providerDestroy]: 0.3,
          [FAILPOINTS.storeRead]: 0.05,
          [FAILPOINTS.storeWrite]: 0.1,
        },
      },
      async (sim) => {
        let harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
        const firstDeps = harness.deps;
        const stop1 = new AbortController();
        const stop2 = new AbortController();
        let restarted = false;
        const result = await sim.runTasks([
          { name: "reconciler-1", f: (task) => reconcileLoop(task, firstDeps, stop1.signal) },
          {
            name: "reconciler-2",
            f: async (task) => {
              await waitUntil(task, "control plane restarted", () => restarted);
              await reconcileLoop(task, harness.deps, stop2.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              while (harness.store.orbSnapshot(ORB)?.state !== "deleting") {
                await requestOrbDeletion(task, firstDeps, ORB);
                await task.sleep(100, "retry delete request");
              }
              await task.sleep(1_000, "allow partial deletion");
              stop1.abort();
              harness = restartControlPlane(harness);
              restarted = true;
              await waitUntil(
                task,
                "deletion recovered",
                () => harness.store.orbSnapshot(ORB) === null,
                {
                  timeoutMs: 300_000,
                },
              );
              stop2.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.world.hostCount(ORB)).toBe(0);
        expect(harness.world.filesystemExists(ORB)).toBe(false);
      },
    );
  });
});
