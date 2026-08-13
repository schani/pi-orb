import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, type TestHarness } from "../testkit/fixtures.ts";
import { assertAtMostOneHost } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { FakeOrbHostProvider } from "../testkit/world.ts";
import { ControlState } from "./control-state.ts";
import { requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type { ControlPlaneDeps } from "./ports.ts";

const ORB = "orb-mixed";
const PROJECT = "project-mixed";

/**
 * Two desired specifications live in the fleet during a deploy. Replacement
 * may move only from generation 1 to generation 2, never backward.
 */
const OLD_GENERATION = 1;
const NEW_GENERATION = 2;

/**
 * One control-plane revision: the shared world and store (one fleet, one
 * database) behind its own host provider and its own in-process state — which
 * is exactly how much two Cloud Run revisions share during a rollover.
 */
function revision(harness: TestHarness, specGeneration: number): ControlPlaneDeps {
  return {
    ...harness.deps,
    hostProvider: new FakeOrbHostProvider(harness.world, 50, specGeneration),
    control: new ControlState(),
  };
}

/** A user-driven stop/start round trip: the window the incident lost. */
async function stopStartCycle(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  harness: TestHarness,
): Promise<void> {
  const stopped = await requestOrbStop(task, deps, ORB);
  expect(stopped.isOk(), stopped.isErr() ? stopped.error.message : "").toBe(true);
  await waitUntil(task, "orb stopped", () => harness.store.orbSnapshot(ORB)?.state === "stopped", {
    timeoutMs: 900_000,
  });
  const started = await requestOrbStart(task, deps, ORB);
  expect(started.isOk(), started.isErr() ? started.error.message : "").toBe(true);
  await waitUntil(
    task,
    "orb running again",
    () => harness.store.orbSnapshot(ORB)?.state === "running",
    { timeoutMs: 900_000 },
  );
}

/**
 * Version skew is part of the model (docs/testing.md, decided 2026-08-06): a
 * deploy briefly runs a heterogeneous fleet. The 2026-08-06 repair war was
 * emergent behavior of exactly that: two reconcilers each treated the other's
 * expected script as damage. Immutable replacement removes mutation, while
 * the committed generation prevents the old revision from replacing the new
 * revision's compute backward.
 */
describe("mixed-generation reconcilers (DST)", () => {
  it("replaces a stale host forward once and never backward during a rollover", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "mixed-generation-rollover", iterations: 40, logCapture: capture },
      async (sim) => {
        // Idle auto-stop is out of scope: the orb is deliberately held running
        // across long virtual stretches with no activity.
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = revision(harness, OLD_GENERATION);
        const newRevision = revision(harness, NEW_GENERATION);
        // The old revision drains away first; the new one outlives it.
        const drainOld = new AbortController();
        const stopAll = new AbortController();
        const result = await sim.runTasks([
          {
            name: "reconciler-old",
            f: (task) => reconcileLoop(task, oldRevision, drainOld.signal),
          },
          // Successful pulls are the only liveness signal, so each revision
          // polls as well; without them a `running` orb is restarted every
          // grace period (docs/testing.md standing interplay).
          { name: "poller-old", f: (task) => pollLoop(task, oldRevision, drainOld.signal) },
          { name: "reconciler-new", f: (task) => reconcileLoop(task, newRevision, stopAll.signal) },
          { name: "poller-new", f: (task) => pollLoop(task, newRevision, stopAll.signal) },
          {
            name: "driver",
            f: async (task) => {
              harness.world.configureOrb(ORB, { initDurationMs: 1_000 });
              harness.store.seedProject(makeProjectRow(PROJECT));
              harness.store.seedOrb(
                makeOrbRow(ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }),
              );
              // Both revisions reconcile the create: whichever provisions first
              // stamps the host, and the loser must not read that as damage.
              await waitUntil(
                task,
                "orb running",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 900_000 },
              );
              // A desired-spec update never bounces healthy running compute,
              // even while both revisions repeatedly reconcile it.
              const running = harness.store.orbSnapshot(ORB);
              const runningRef = running?.hostRef;
              const runningIncarnation = running?.hostIncarnation;
              await task.sleep(10_000, "observe running orb under version skew");
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostRef: runningRef,
                hostIncarnation: runningIncarnation,
              });
              // The ordinary stop/start is the only replacement trigger.
              await stopStartCycle(task, newRevision, harness);
              // The deploy finishes: the drained revision goes away.
              drainOld.abort();
              // The survivor must now own the host outright.
              await stopStartCycle(task, newRevision, harness);
              stopAll.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);

        const orb = harness.store.orbSnapshot(ORB);
        // (a) Replacement is forward-only and bounded to one incarnation for
        // this one effective spec change; no in-place repair exists.
        expect(orb?.hostSpecGeneration).toBe(NEW_GENERATION);
        expect(orb?.hostIncarnation).toBeLessThanOrEqual(1);
        // (b) The skew must not deny service — neither by livelock nor by a
        // terminal failure decided on another episode's clocks.
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
        expect(capture.matching("to=failed")).toEqual([]);
        // (c) A lower-generation guard is observable whenever it wins the
        // stale pass; it can never produce a backward replacement.
        expect(capture.matching("compute-discard-requested").length).toBeLessThanOrEqual(1);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });
});
