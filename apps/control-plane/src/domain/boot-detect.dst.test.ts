import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, type TestHarness } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

function seedCreatingOrb(task: SimulationTask, harness: TestHarness): void {
  harness.store.seedProject(makeProjectRow(PROJECT));
  harness.store.seedOrb(makeOrbRow(ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }));
}

describe("boot-failure detection (DST)", () => {
  it("a host whose runtime never answers fails fast with host evidence", async () => {
    await runDst({ name: "boot-never-answers", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      let failedAtMono = 0;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { containerNeverStarts: true });
            harness.world.setDiagnosis(ORB, "startup-script failed at: docker run");
            seedCreatingOrb(task, harness);
            const startedAt = task.monotonicNow();
            // Must fail well before the 120s create deadline: the sub-deadline
            // is 20s in test constants.
            await waitUntil(
              task,
              "orb failed fast",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 90_000 },
            );
            failedAtMono = task.monotonicNow() - startedAt;
            // A cancelled best-effort stop is repaired by the backstop sweep.
            await waitUntil(
              task,
              "host stopped",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 30_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.lastError).toContain("runtime_never_answered");
      // The provider's host-side evidence reaches the terminal error.
      expect(orb?.lastError).toContain("startup-script failed at: docker run");
      expect(failedAtMono).toBeLessThan(90_000);
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("a slow but reachable init never trips the sub-deadline", async () => {
    await runDst({ name: "boot-slow-reachable", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            // Health answers immediately (initializing) but ready only after
            // 40s — twice the unreachable sub-deadline.
            harness.world.configureOrb(ORB, { initDurationMs: 40_000 });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb running despite slow init",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 110_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("the boot probe exposes the live picture while stuck", async () => {
    await runDst({ name: "boot-probe-visibility", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { containerNeverStarts: true });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "probes recorded",
              () => (harness.deps.control.getBootProbe(ORB)?.attempts ?? 0) >= 2,
              { timeoutMs: 30_000 },
            );
            const probe = harness.deps.control.getBootProbe(ORB);
            expect(probe?.hostState).toBe("running");
            expect(probe?.everAnswered).toBe(false);
            expect(probe?.hostRunningSinceMono).not.toBeNull();
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
