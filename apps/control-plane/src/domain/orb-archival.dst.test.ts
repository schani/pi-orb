import { describe, expect, it } from "vitest";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { requestOrbArchive, requestOrbDeletion, requestOrbStart } from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-archive";

describe("orb archival (DST)", () => {
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
