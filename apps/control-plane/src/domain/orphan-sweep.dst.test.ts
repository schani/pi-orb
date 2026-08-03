import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  seedRunningOrb,
  TEST_CONSTANTS,
} from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { orphanSweepLoop, pollLoop, reconcileLoop } from "./loops.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

describe("orphan-host sweep (DST)", () => {
  it("stops a running host that has no orb row, without deleting it", async () => {
    await runDst(
      {
        name: "sweep-no-orb-row",
        iterations: 20,
        failpointProbabilities: {
          [FAILPOINTS.providerObserve]: 0.2,
          [FAILPOINTS.providerStop]: 0.2,
          [FAILPOINTS.storeRead]: 0.05,
        },
      },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "sweeper", f: (task) => orphanSweepLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              // A provision whose database commit was lost: host, no orb row.
              harness.world.configureOrb(ORB, { initDurationMs: 0 });
              harness.world.provisionHost(task, ORB);
              await waitUntil(
                task,
                "orphan host stopped",
                () => harness.world.hostStateOf(ORB) === "stopped",
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Stopped, never deleted: the filesystem is authoritative.
        expect(harness.world.hostCount(ORB)).toBe(1);
        expect(harness.world.hostStateOf(ORB)).toBe("stopped");
      },
    );
  });

  it("stops a running host whose terminal orb row lost its host_ref", async () => {
    await runDst({ name: "sweep-lost-host-ref", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "sweeper", f: (task) => orphanSweepLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedProject(makeProjectRow(PROJECT));
            harness.world.configureOrb(ORB, { initDurationMs: 0 });
            harness.world.provisionHost(task, ORB);
            // The stopped orb row no longer records the host, so the per-orb
            // terminal backstop cannot see it — only the sweep can.
            harness.store.seedOrb(makeOrbRow(ORB, PROJECT, "stopped", { hostRef: null }));
            await waitUntil(
              task,
              "lost-ref host stopped",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
      expect(harness.world.hostCount(ORB)).toBe(1);
    });
  });

  it("never touches the host of a live running orb", async () => {
    await runDst({ name: "sweep-leaves-live-orbs", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        { name: "sweeper", f: (task) => orphanSweepLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            await task.sleep(5 * TEST_CONSTANTS.orphanSweepIntervalMs, "several sweep cycles");
            expect(harness.world.hostStateOf(ORB)).toBe("running");
            expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.world.hostStateOf(ORB)).toBe("running");
    });
  });
});
