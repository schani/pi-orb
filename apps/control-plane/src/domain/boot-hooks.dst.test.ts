import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { orbView } from "../http/views.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  TEST_CONSTANTS,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
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

/**
 * Wait for the orb to run, treating `failed` as an immediate scenario failure
 * rather than a timeout: every scenario below is about a boot that must
 * survive, and the terminal error is the evidence worth reporting.
 */
async function waitForRunning(task: SimulationTask, harness: TestHarness): Promise<void> {
  await waitUntil(
    task,
    "orb running",
    () => {
      const row = harness.store.orbSnapshot(ORB);
      if (row?.state === "failed") throw new Error(`orb failed: ${row.lastError}`);
      return row?.state === "running";
    },
    { timeoutMs: CONVERGE_MS },
  );
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

  it("tells a silent runtime apart from one that is still running setup", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "setup-then-silence-fails", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        let failedAfterSilenceMs = -1;
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
              // The runtime goes dark mid-hook and answers nothing again, while
              // the host still observes as running — the shape of a wedged or
              // preempted runtime. The hold must not read that silence as a
              // script still working.
              harness.world.setRuntimeUnreachable(task, ORB, CONVERGE_MS * 2);
              const silentAt = task.monotonicNow();
              await waitUntil(
                task,
                "orb failed once the runtime went properly silent",
                () => harness.store.orbSnapshot(ORB)?.state === "failed",
                { timeoutMs: CONVERGE_MS },
              );
              failedAfterSilenceMs = task.monotonicNow() - silentAt;
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Either boot-failure path is a correct answer here — what matters is
        // that the hold does not suppress them.
        expect(harness.store.orbSnapshot(ORB)?.lastError).toMatch(
          /deadline_exceeded|runtime_never_answered/,
        );
        // This is what distinguishes silence from a hook that is still working:
        // an identically configured setup that keeps reporting survives all the
        // way to `setupHookHoldMs` (the scenario above), while a silent runtime
        // is failed well inside it.
        expect(failedAfterSilenceMs, capture.lines().join("\n")).toBeLessThan(
          TEST_CONSTANTS.setupHookHoldMs,
        );
      },
    );
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

  it("logs a fresh edge when the next incarnation's setup fails too", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "setup-failed-per-incarnation", iterations: 20, logCapture: capture },
      async (sim) => {
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
                hooks: { setupOutcome: "failed", setupDurationMs: 5_000 },
              });
              seedCreatingOrb(task, harness);
              await waitUntil(
                task,
                "orb running",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: CONVERGE_MS },
              );
              expect(capture.matching("setup-failed")).toHaveLength(1);

              // Stop/start of the retained incarnation re-reports the same
              // verdict about the same compute: one condition, still one edge.
              await stopStartCycle(task, harness.deps, harness);
              expect(capture.matching("setup-failed")).toHaveLength(1);

              // A replacement runs the hook afresh on new compute. That is a
              // new outcome, and the operator must see it.
              harness.world.setDesiredSpec("spec-updated");
              await stopStartCycle(task, harness.deps, harness);
              expect(harness.world.hostIncarnationOf(ORB)).toBe(1);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("setup-failed")).toHaveLength(2);
        expect(capture.matching("setup-failed")[1]).toContain("incarnation=1");
      },
    );
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

describe("orb boot hook races (DST)", () => {
  it("keeps the hold across a control-plane restart in the middle of setup", async () => {
    await runDst({ name: "setup-hold-across-restart", iterations: 20 }, async (sim) => {
      let harness = makeHarness();
      // The first process dies; the second one inherits nothing but the store,
      // the world, and whatever the runtime is still willing to tell it.
      const firstProcess = new AbortController();
      const stop = new AbortController();
      let secondProcess: ControlPlaneDeps | null = null;
      // Longer than the ordinary deadline, shorter than the hold: the orb can
      // only survive if the restarted process re-establishes the hold.
      const setupDurationMs = TEST_CONSTANTS.createStartDeadlineMs + 90_000;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            await reconcileLoop(task, harness.deps, firstProcess.signal);
            await waitUntil(task, "control plane restarted", () => secondProcess !== null, {
              timeoutMs: CONVERGE_MS,
            });
            if (secondProcess !== null) await reconcileLoop(task, secondProcess, stop.signal);
          },
        },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              hooks: { setupOutcome: "ok", setupDurationMs, resumeOutcome: "ok" },
            });
            seedCreatingOrb(task, harness);
            const startedAt = task.wallNow();
            await waitUntil(
              task,
              "setup running",
              () => harness.deps.control.getBootProbe(ORB)?.setupRunning === true,
              { timeoutMs: CONVERGE_MS },
            );
            // Deliberately past the ordinary deadline: a process that starts
            // here and applies that deadline before it has probed anything
            // kills a healthy orb whose hook is still working.
            await waitUntil(
              task,
              "ordinary create/start deadline outlasted",
              () => task.wallNow() - startedAt > TEST_CONSTANTS.createStartDeadlineMs,
              { timeoutMs: CONVERGE_MS },
            );
            expect(harness.store.orbSnapshot(ORB)?.state).toBe("creating");
            firstProcess.abort();
            harness = restartControlPlane(harness);
            secondProcess = harness.deps;
            await waitForRunning(task, harness);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toBeNull();
      expect(harness.world.hostIncarnationOf(ORB)).toBe(0);
      // One incarnation, one setup: the restart must not have re-run it.
      expect(harness.world.setupRunsOf(ORB)).toEqual([0]);
    });
  });

  it("stops cleanly during setup and runs it again on the next start", async () => {
    await runDst({ name: "stop-during-setup", iterations: 20 }, async (sim) => {
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
              hooks: { setupOutcome: "ok", setupDurationMs: 120_000, resumeOutcome: "ok" },
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "setup running",
              () => harness.deps.control.getBootProbe(ORB)?.setupRunning === true,
              { timeoutMs: CONVERGE_MS },
            );
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk(), stopped.isErr() ? stopped.error.message : "").toBe(true);
            await waitUntil(
              task,
              "orb stopped mid-setup",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: CONVERGE_MS },
            );
            // The hook died with the orb, so nothing claims this compute has
            // had its setup: the stamp is the runtime's, written only by a hook
            // that reached a verdict (docs/orb-setup-hook.md).
            expect(harness.world.setupIncarnationOf(ORB)).toBeNull();
            expect(harness.world.setupRunsOf(ORB)).toEqual([]);
            expect(harness.world.hookStatusesOf(ORB).setup).toBeUndefined();

            const started = await requestOrbStart(task, harness.deps, ORB);
            expect(started.isOk(), started.isErr() ? started.error.message : "").toBe(true);
            await waitForRunning(task, harness);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // Same compute, and its single setup is the one that finished.
      expect(harness.world.hostIncarnationOf(ORB)).toBe(0);
      expect(harness.world.setupRunsOf(ORB)).toEqual([0]);
      expect(view(harness)?.stateDetail).toBeUndefined();
    });
  });

  it("replaces compute mid-setup and runs setup once on each incarnation", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "spec-change-during-setup", iterations: 20, logCapture: capture },
      async (sim) => {
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
                hooks: { setupOutcome: "ok", setupDurationMs: 120_000, resumeOutcome: "ok" },
              });
              seedCreatingOrb(task, harness);
              await waitUntil(
                task,
                "setup running on the first incarnation",
                () => harness.deps.control.getBootProbe(ORB)?.setupRunning === true,
                { timeoutMs: CONVERGE_MS },
              );
              // The launch specification changes under a boot whose hook is
              // still working: that compute is stale before it ever ran
              // (docs/compute-replacement.md).
              harness.world.setDesiredSpec("spec-updated");
              await waitForRunning(task, harness);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.world.hostIncarnationOf(ORB)).toBe(1);
        // The discarded incarnation never finished its hook, and the new one
        // ran it exactly once — never twice on the same compute.
        expect(harness.world.setupRunsOf(ORB)).toEqual([1]);
        expect(harness.world.hookStatusesOf(ORB).setup?.incarnation).toBe("1");
        const requests = capture.matching("compute-discard-requested");
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("reason=host_spec_changed");
      },
    );
  });

  it("never idle-stops an orb whose setup hook is still running", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "idle-stop-never-preempts-setup", iterations: 20, logCapture: capture },
      async (sim) => {
        // The ordinary idle window, deliberately not widened: idle auto-stop
        // considers only `running` orbs, and a boot the setup hook holds open
        // is `creating` for many times that window (docs/lifecycle.md).
        const harness = makeHarness();
        const setupDurationMs = TEST_CONSTANTS.idleStopAfterMs * 6;
        expect(setupDurationMs).toBeLessThan(TEST_CONSTANTS.createStartDeadlineMs);
        const stop = new AbortController();
        let heldForMs = -1;
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              harness.world.configureOrb(ORB, {
                hooks: { setupOutcome: "ok", setupDurationMs, resumeOutcome: "ok" },
              });
              seedCreatingOrb(task, harness);
              const startedAt = task.monotonicNow();
              await waitUntil(
                task,
                "orb running without ever being stopped",
                () => {
                  const state = harness.store.orbSnapshot(ORB)?.state;
                  if (state === "stopping" || state === "stopped" || state === "failed") {
                    throw new Error(`orb left its boot as ${state}`);
                  }
                  return state === "running";
                },
                { timeoutMs: CONVERGE_MS },
              );
              heldForMs = task.monotonicNow() - startedAt;
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // The boot outlasted the idle window several times over, so "no idle
        // stop" is a decision the scenario forced, not one it missed.
        expect(heldForMs).toBeGreaterThan(TEST_CONSTANTS.idleStopAfterMs * 2);
        expect(harness.store.orbSnapshot(ORB)?.stopReason).toBeNull();
        expect(capture.matching("reason=idle")).toEqual([]);
      },
    );
  });

  it("re-runs only resume when the runtime restarts inside one incarnation", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "runtime-restart-runs-resume-only", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        let resumeRunsBefore = -1;
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
              await waitForRunning(task, harness);
              expect(harness.world.setupRunsOf(ORB)).toEqual([0]);
              resumeRunsBefore = harness.world.resumeRunsOf(ORB);

              // The runtime goes dark long enough for the reconciler's
              // unreachable restart, and comes back well inside the boot that
              // restart pays for: same compute, new runtime process.
              harness.world.setRuntimeUnreachable(task, ORB, TEST_CONSTANTS.unreachableGraceMs * 3);
              await waitUntil(
                task,
                "orb left running for the restart",
                () => harness.store.orbSnapshot(ORB)?.state !== "running",
                { timeoutMs: CONVERGE_MS },
              );
              await waitForRunning(task, harness);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Same incarnation, so the durable stamp still stands: setup is not
        // re-run, resume is (docs/orb-setup-hook.md, triggers table).
        expect(harness.world.hostIncarnationOf(ORB)).toBe(0);
        expect(harness.world.setupRunsOf(ORB)).toEqual([0]);
        expect(harness.world.resumeRunsOf(ORB)).toBeGreaterThan(resumeRunsBefore);
        expect(capture.matching("setup-failed")).toEqual([]);
        expect(capture.matching("resume-failed")).toEqual([]);
        expect(view(harness)?.stateDetail).toBeUndefined();
      },
    );
  });
});

describe("orb boot hook crash windows (DST)", () => {
  /**
   * Hand-driven passes, as the compute-replacement crash sweep drives them
   * (lifecycle.dst.test.ts): nothing happens between passes, so the durable
   * state a crash leaves behind is exactly the one the scenario arranged.
   */
  async function drive(
    task: SimulationTask,
    harness: TestHarness,
    reason: string,
    predicate: () => boolean,
    attempts = 2_000,
  ): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await reconcileOrbOnce(task, harness.deps, ORB);
      if (predicate()) return;
      await task.sleep(500, reason);
    }
    expect.fail(`crash window never reached: ${reason}`);
  }

  const pastOrdinaryDeadline = (task: SimulationTask, harness: TestHarness): boolean => {
    const row = harness.store.orbSnapshot(ORB);
    return (
      row !== null && task.wallNow() - row.stateChangedAt > TEST_CONSTANTS.createStartDeadlineMs
    );
  };

  interface CrashWindow {
    readonly name: string;
    /** The repository's hooks and the boot they produce. */
    readonly configure: (harness: TestHarness) => void;
    /** Drive to the durable state a crash at this checkpoint leaves behind. */
    readonly arrange: (task: SimulationTask, harness: TestHarness) => Promise<void>;
    /** What must be durably true while the control plane is dead. */
    readonly assertDurable: (harness: TestHarness) => void;
    /** What must hold once the restarted process has finished the boot. */
    readonly assertConverged: (harness: TestHarness) => void;
  }

  const failedHooks = (harness: TestHarness): void =>
    harness.world.configureOrb(ORB, {
      hooks: { setupOutcome: "failed", setupDurationMs: 5_000, resumeOutcome: "ok" },
    });

  const setupFailureVisible = (harness: TestHarness): void => {
    expect(harness.store.orbSnapshot(ORB)).toMatchObject({
      hookFailureHook: "setup",
      hookFailureReason: "failed",
      hookFailureLog: "/workspace/home/.cache/pi-orb/logs/setup.log",
    });
    expect(view(harness)?.stateDetail).toMatchObject({ type: "setup_failed", hook: "setup" });
  };

  const windows: readonly CrashWindow[] = [
    {
      // boot-hooks.hold-before-anchor / hold-anchored: the anchor lives only in
      // the dead process, and the hook is still working.
      name: "hold-anchored",
      configure: (harness) =>
        harness.world.configureOrb(ORB, {
          hooks: {
            setupOutcome: "ok",
            setupDurationMs: TEST_CONSTANTS.createStartDeadlineMs + 90_000,
            resumeOutcome: "ok",
          },
        }),
      arrange: (task, harness) =>
        drive(
          task,
          harness,
          "drive into a setup that has outlasted the ordinary deadline",
          () =>
            harness.deps.control.getBootProbe(ORB)?.setupRunning === true &&
            pastOrdinaryDeadline(task, harness),
        ),
      assertDurable: (harness) => {
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("creating");
        expect(harness.world.setupRunsOf(ORB)).toEqual([]);
      },
      assertConverged: (harness) => {
        expect(harness.world.setupRunsOf(ORB)).toEqual([0]);
        expect(view(harness)?.stateDetail).toBeUndefined();
      },
    },
    {
      // boot-hooks.hold-anchored, reseeded: the hook has finished and only the
      // start time the runtime persisted can rebuild the hold.
      name: "hold-reseeded",
      configure: (harness) =>
        harness.world.configureOrb(ORB, {
          initDurationMs: 90_000,
          hooks: {
            setupOutcome: "ok",
            setupDurationMs: TEST_CONSTANTS.createStartDeadlineMs - 60_000,
            resumeOutcome: "ok",
          },
        }),
      arrange: (task, harness) =>
        drive(
          task,
          harness,
          "drive past a finished setup into the boot it delayed",
          () => harness.world.setupRunsOf(ORB).length === 1 && pastOrdinaryDeadline(task, harness),
        ),
      assertDurable: (harness) => {
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("creating");
        expect(harness.world.hookStatusesOf(ORB).setup?.outcome).toBe("ok");
      },
      assertConverged: (harness) => {
        expect(harness.world.setupRunsOf(ORB)).toEqual([0]);
        expect(view(harness)?.stateDetail).toBeUndefined();
      },
    },
    {
      // boot-hooks.failure-before-persist: the runtime has reached a verdict
      // and no column carries it yet.
      name: "failure-before-persist",
      configure: failedHooks,
      arrange: async (task, harness) => {
        harness.store.failNextReadyIdentityWrites(1);
        await drive(task, harness, "drive to the unpersisted hook verdict", () => {
          return harness.store.pendingScriptedBootFailures() === 0;
        });
      },
      assertDurable: (harness) => {
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          state: "creating",
          hookFailureHook: null,
          hookFailureReason: null,
          hookFailureLog: null,
        });
      },
      assertConverged: setupFailureVisible,
    },
    {
      // boot-hooks.failure-persisted / before-ready-after-setup: the verdict is
      // durable and the boot it describes has not ended.
      name: "failure-persisted",
      configure: failedHooks,
      arrange: async (task, harness) => {
        harness.store.failNextRunningTransitions(1);
        await drive(task, harness, "drive to the persisted-but-unfinished boot", () => {
          return harness.store.pendingScriptedBootFailures() === 0;
        });
      },
      assertDurable: (harness) => {
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          state: "creating",
          hookFailureHook: "setup",
          hookFailureReason: "failed",
        });
      },
      assertConverged: setupFailureVisible,
    },
  ];

  for (const window of windows) {
    it(`resumes from durable state after death at ${window.name}`, async () => {
      await runDst({ name: `boot-hooks-crash-${window.name}`, iterations: 20 }, async (sim) => {
        let harness = makeHarness({
          constants: { idleStopAfterMs: 3_600_000, unreachableGraceMs: 600_000 },
        });
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              window.configure(harness);
              seedCreatingOrb(task, harness);
              await window.arrange(task, harness);
              window.assertDurable(harness);
              // Process death: every in-memory anchor, condition, and probe is
              // gone; the store, the world, and the runtime's own persisted
              // status are all the next process has.
              harness = restartControlPlane(harness);
              await drive(
                task,
                harness,
                "converge after process death",
                () => {
                  const row = harness.store.orbSnapshot(ORB);
                  if (row?.state === "failed") {
                    throw new Error(`orb failed after process death: ${row.lastError}`);
                  }
                  return row?.state === "running";
                },
                4_000,
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          state: "running",
          hostIncarnation: 0,
          lastError: null,
        });
        window.assertConverged(harness);
      });
    });
  }
});

describe("orb boot hooks under failpoints (DST)", () => {
  /** All three hook columns move together, or none of them do. */
  function assertHookColumnsWhole(harness: TestHarness): void {
    const row = harness.store.orbSnapshot(ORB);
    expect(row).not.toBeNull();
    const set = [row?.hookFailureHook, row?.hookFailureReason, row?.hookFailureLog].filter(
      (column) => column !== null && column !== undefined,
    );
    expect(
      set.length === 0 || set.length === 3,
      `half-written hook columns: ${set.join(",")}`,
    ).toBe(true);
  }

  it("keeps the held boot and its hook verdict whole under store failures", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "setup-hold-under-store-failpoints",
        iterations: 20,
        logCapture: capture,
        failpointProbabilities: {
          [FAILPOINTS.storeWrite]: 0.05,
          [FAILPOINTS.storeRead]: 0.05,
        },
      },
      async (sim) => {
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
                  setupDurationMs: TEST_CONSTANTS.createStartDeadlineMs + 60_000,
                  resumeOutcome: "failed",
                },
              });
              seedCreatingOrb(task, harness);
              await waitUntil(
                task,
                "orb running while the store misbehaves",
                () => {
                  assertHookColumnsWhole(harness);
                  const row = harness.store.orbSnapshot(ORB);
                  if (row?.state === "failed") {
                    throw new Error(`orb failed under store failures: ${row.lastError}`);
                  }
                  return row?.state === "running";
                },
                { timeoutMs: CONVERGE_MS },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertHookColumnsWhole(harness);
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          hookFailureHook: "setup",
          hookFailureReason: "failed",
        });
        // Retried writes must not become retried edges.
        expect(capture.matching("setup-failed")).toHaveLength(1);
        expect(capture.matching("resume-failed")).toHaveLength(1);
      },
    );
  });

  it("keeps the hold across intermittent health failures", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "setup-hold-under-health-failpoints",
        iterations: 20,
        logCapture: capture,
        failpointProbabilities: { [FAILPOINTS.runtimeHealth]: 0.25 },
      },
      async (sim) => {
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
                  setupDurationMs: TEST_CONSTANTS.createStartDeadlineMs + 60_000,
                  resumeOutcome: "ok",
                },
              });
              seedCreatingOrb(task, harness);
              // A probe that fails is not a runtime that died: the hold has to
              // survive dropped answers while the hook keeps working.
              await waitForRunning(task, harness);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertHookColumnsWhole(harness);
        expect(capture.matching("setup-failed")).toHaveLength(1);
        expect(capture.matching("resume-failed")).toEqual([]);
      },
    );
  });
});
