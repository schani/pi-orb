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
 * The two script generations live in the fleet during a deploy. Every host
 * here is stamped with one of them, so a repair can only ever be the single
 * forward step 1 → 2.
 */
const OLD_GENERATION = 1;
const NEW_GENERATION = 2;
const GENERATIONS = 2;

/**
 * One control-plane revision: the shared world and store (one fleet, one
 * database) behind its own host provider and its own in-process state — which
 * is exactly how much two Cloud Run revisions share during a rollover.
 */
function revision(harness: TestHarness, scriptGeneration: number): ControlPlaneDeps {
  return {
    ...harness.deps,
    hostProvider: new FakeOrbHostProvider(harness.world, 50, scriptGeneration),
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
 * deploy briefly runs a heterogeneous fleet, and the repair war of
 * `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md` was
 * emergent behavior of exactly that — two reconcilers whose *expected scripts
 * differed*, each reading the other's script as damage.
 *
 * Flip the fake's one fencing predicate (`FakeWorld.repairIsNeeded`) to the
 * unfenced rule `ensureCurrentScript` used before 2026-08-06 — repair on any
 * generation difference — and this scenario fails in its first iterations on
 * a backward 2 → 1 repair, which 14 of 20 sampled schedules produce. Unfenced,
 * one create plus two stop/start cycles cost up to 3 repairs and 6 host stops;
 * fenced, at most 1 repair and 5 stops.
 */
describe("mixed-generation reconcilers (DST)", () => {
  it("repairs a host forward once and never backward during a rollover", async () => {
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
              // The incident's trigger: a user stop/start while both revisions
              // are live, so both meet a stopped host and both want to start it.
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

        const repairs = harness.world.scriptRepairsOf(ORB);
        // (a) No backward repair, ever: the fence is the whole point.
        for (const repair of repairs) {
          expect(repair.to, `repair ${repair.from} -> ${repair.to} went backward`).toBeGreaterThan(
            repair.from,
          );
        }
        // (b) Bounded by the generations in the fleet, not by the number of
        // reconcile passes: a war grows this without limit.
        expect(repairs.length).toBeLessThanOrEqual(GENERATIONS);
        // (c) The skew must not deny service — neither by livelock nor by a
        // terminal failure decided on another episode's clocks.
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
        expect(capture.matching("to=failed")).toEqual([]);
        // (d) The survivor converged the host onto its own generation.
        expect(harness.world.scriptGenerationOf(ORB)).toBe(NEW_GENERATION);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });
});
