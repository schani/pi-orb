import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { orbView } from "../http/views.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  TEST_CONSTANTS,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type { ControlPlaneDeps } from "./ports.ts";

const ORB = "orb-hooks";
const PROJECT = "project-hooks";

/** Two modeled host boots plus the longest setup any scenario scripts. */
const CONVERGE_MS = 1_200_000;

function seedCreatingOrb(task: SimulationTask, harness: TestHarness): void {
  harness.store.seedProject(makeProjectRow(PROJECT));
  harness.store.seedOrb(makeOrbRow(ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }));
}

/** The orb as the browser sees it, so assertions read the shipped surface. */
function view(harness: TestHarness): ReturnType<typeof orbView> | null {
  const row = harness.store.orbSnapshot(ORB);
  return row === null || row === undefined ? null : orbView(row, harness.deps.control, {});
}

/**
 * Wait in short steps: a single long timer is not a long wait to this
 * scheduler, whose late-firing exploration can teleport virtual time past
 * every other deadline at once (docs/testing.md).
 */
async function sleepInSteps(task: SimulationTask, totalMs: number, reason: string): Promise<void> {
  const until = task.monotonicNow() + totalMs;
  while (task.monotonicNow() < until) {
    await task.sleep(Math.min(until - task.monotonicNow(), 500), reason);
  }
}

async function stopStartCycle(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  harness: TestHarness,
): Promise<void> {
  const stopped = await requestOrbStop(task, deps, ORB);
  expect(stopped.isOk(), stopped.isErr() ? stopped.error.message : "").toBe(true);
  await waitUntil(task, "orb stopped", () => harness.store.orbSnapshot(ORB)?.state === "stopped", {
    timeoutMs: CONVERGE_MS,
  });
  const started = await requestOrbStart(task, deps, ORB);
  expect(started.isOk(), started.isErr() ? started.error.message : "").toBe(true);
  await waitUntil(
    task,
    "orb running again",
    () => harness.store.orbSnapshot(ORB)?.state === "running",
    { timeoutMs: CONVERGE_MS },
  );
}

describe("orb boot hooks (DST)", () => {
  it("holds the boot deadline while the runtime reports setup_running", async () => {
    await runDst({ name: "setup-holds-boot-deadline", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      // Comfortably past the create/start deadline, comfortably inside the
      // hold: only the hold can explain the orb reaching `running`.
      const setupDurationMs = TEST_CONSTANTS.createStartDeadlineMs + 60_000;
      expect(setupDurationMs).toBeLessThan(TEST_CONSTANTS.setupHookHoldMs);
      let sawRunningSetup = false;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              hooks: { setupOutcome: "ok", setupDurationMs, resumeOutcome: "ok" },
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "setup reported to the user",
              () => {
                sawRunningSetup ||= view(harness)?.stateDetail?.type === "running_setup";
                return sawRunningSetup;
              },
              { timeoutMs: CONVERGE_MS },
            );
            await waitUntil(
              task,
              "orb running",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: CONVERGE_MS },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(sawRunningSetup).toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toBeNull();
      // Success is silent in the product and in the log.
      expect(view(harness)?.stateDetail).toBeUndefined();
    });
  });

  it("still fails a runtime that claims setup past the hold", async () => {
    await runDst({ name: "setup-hold-is-bounded", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            // A hook that never ends is a stuck runtime, not a slow one: the
            // hold is bounded by the runtime's own deadline plus grace.
            harness.world.configureOrb(ORB, {
              hooks: {
                setupOutcome: "ok",
                setupDurationMs: TEST_CONSTANTS.setupHookHoldMs * 3,
                resumeOutcome: "ok",
              },
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb failed on deadline",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: CONVERGE_MS },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("deadline_exceeded");
    });
  });

  it("fails a runtime that goes silent after reporting setup_running", async () => {
    await runDst({ name: "setup-then-silence-fails", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              hooks: {
                setupOutcome: "ok",
                setupDurationMs: TEST_CONSTANTS.setupHookHoldMs * 3,
                resumeOutcome: "ok",
              },
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "setup reported",
              () => harness.deps.control.getBootProbe(ORB)?.setupRunningSinceMono !== null,
              { timeoutMs: CONVERGE_MS },
            );
            // The runtime dies mid-hook. Nothing will report anything again,
            // and the hold's own bound is the only thing that ends the boot —
            // a runtime that stops reporting is still a dead runtime.
            harness.world.killRuntimeProcess(ORB);
            await waitUntil(
              task,
              "orb failed once the hold expired",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: CONVERGE_MS },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("deadline_exceeded");
    });
  });

  it("starts the orb after a failed setup, tells the user, and logs one edge each", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "setup-failed-still-runs", iterations: 20, logCapture: capture },
      async (sim) => {
        // This scenario is about edges, not liveness: idle auto-stop and the
        // unreachable restart are pushed past the whole run so no schedule can
        // start a second boot episode and log a second edge legitimately.
        const harness = makeHarness({
          constants: { idleStopAfterMs: 3_600_000, unreachableGraceMs: 600_000 },
        });
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              harness.world.configureOrb(ORB, {
                hooks: {
                  setupOutcome: "failed",
                  setupDurationMs: 5_000,
                  resumeOutcome: "failed",
                },
              });
              seedCreatingOrb(task, harness);
              await waitUntil(
                task,
                "orb running despite the failed hooks",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: CONVERGE_MS },
              );
              // Many more reconcile passes must not repeat the edges: a
              // persisting condition is logged once (docs/lifecycle.md).
              await sleepInSteps(task, 30_000, "reconcile a running orb with failed hooks");
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)?.lastError).toBeNull();
        expect(capture.matching("setup-failed")).toHaveLength(1);
        expect(capture.matching("resume-failed")).toHaveLength(1);
        // The reason and the log path reach the log; the output never does.
        expect(capture.matching("setup-failed")[0]).toContain("reason=failed");
        expect(capture.matching("setup-failed")[0]).toContain(
          "log=/workspace/home/.cache/pi-orb/logs/setup.log",
        );
        expect(view(harness)?.stateDetail).toEqual({
          type: "setup_failed",
          hook: "setup",
          reason: "failed",
          logPath: "/workspace/home/.cache/pi-orb/logs/setup.log",
        });
      },
    );
  });

  it("starts the orb after a setup that timed out", async () => {
    await runDst({ name: "setup-timeout-still-runs", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              hooks: { setupOutcome: "timeout", setupDurationMs: 5_000 },
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb running after the setup timeout",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: CONVERGE_MS },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(view(harness)?.stateDetail).toMatchObject({
        type: "setup_failed",
        hook: "setup",
        reason: "timeout",
      });
    });
  });

  it("re-runs setup on a replacement incarnation but not on stop/start", async () => {
    await runDst({ name: "setup-per-incarnation", iterations: 20 }, async (sim) => {
      // Idle auto-stop and the unreachable restart are pushed past the whole
      // scenario: this one is about incarnations, not liveness.
      const harness = makeHarness({
        constants: { idleStopAfterMs: 3_600_000, unreachableGraceMs: 600_000 },
      });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              hooks: { setupOutcome: "ok", setupDurationMs: 5_000, resumeOutcome: "ok" },
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb running",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: CONVERGE_MS },
            );
            expect(harness.world.setupIncarnationOf(ORB)).toBe(0);

            // Stop/start of the retained incarnation: resume only.
            await stopStartCycle(task, harness.deps, harness);
            expect(harness.world.hostIncarnationOf(ORB)).toBe(0);
            expect(harness.world.setupIncarnationOf(ORB)).toBe(0);
            expect(harness.world.hookStatusesOf(ORB).setup?.incarnation).toBe("0");

            // A new specification replaces the compute on the next start; the
            // container layer setup wrote into is gone, so setup runs again.
            harness.world.setDesiredSpec("spec-updated");
            await stopStartCycle(task, harness.deps, harness);
            expect(harness.world.hostIncarnationOf(ORB)).toBe(1);
            await waitUntil(
              task,
              "setup ran for the replacement incarnation",
              () => harness.world.setupIncarnationOf(ORB) === 1,
              { timeoutMs: CONVERGE_MS },
            );
            expect(harness.world.hookStatusesOf(ORB).setup?.incarnation).toBe("1");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
