import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  seedRunningOrb,
  TEST_CONSTANTS,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { orphanSweepLoop, pollLoop, reconcileLoop } from "./loops.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

describe("orphan-host sweep (DST)", () => {
  it("stops a running host that has no orb row, without deleting it", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "sweep-no-orb-row",
        iterations: 20,
        logCapture: capture,
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
        // The integrity signal names the orb and why the host was stopped.
        const orphanLines = capture.matching("orphan-host ");
        expect(orphanLines.length).toBeGreaterThanOrEqual(1);
        expect(orphanLines[0]).toContain(`orb=${ORB}`);
        expect(orphanLines[0]).toContain("reason=no_orb_row");
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

  // The subject is what the *sweep* does, which is why the assertions are about
  // the sweep's decisions rather than about the host's state at an arbitrary
  // instant. Asserting "host running" after the tasks stopped made this
  // scenario flaky before 2026-08-06 (2 failures in 6 full-suite runs, trace
  // `sweep-leaves-live-orbs`): a scheduler-legal 10 s liveness lapse lets the
  // reconciler start an unreachable-runtime restart whose `start` half is then
  // cancelled by its own deadline, so the scenario can legitimately end with a
  // stopped host mid-recovery. The reconciler's own log made that diagnosis a
  // one-line read (docs/lifecycle.md).
  it("never touches the host of a live running orb", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "sweep-leaves-live-orbs", iterations: 15, logCapture: capture },
      async (sim) => {
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
              // A live orb may be mid-restart, but it is never terminal.
              const state = harness.store.orbSnapshot(ORB)?.state;
              expect(state === "stopped" || state === "failed").toBe(false);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // The sweep never claimed this host as an orphan, on any schedule.
        expect(capture.matching("orphan-host")).toEqual([]);
        expect(harness.world.hostCount(ORB)).toBe(1);
      },
    );
  });
});
