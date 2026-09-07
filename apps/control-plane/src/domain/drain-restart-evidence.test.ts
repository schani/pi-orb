import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import {
  makeHarness,
  restartControlPlane,
  seedRunningOrb,
  TEST_CONSTANTS,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { reconcileOrbOnce, requestOrbStop } from "./lifecycle.ts";
import type { ControlPlaneDeps, OrbHostProvider } from "./ports.ts";

const ORB = "orb-drain-restart-evidence";

function withStartedAt(harness: TestHarness, lastStartedAt: number | undefined): ControlPlaneDeps {
  const original = harness.deps.hostProvider;
  const hostProvider = new Proxy(original, {
    get(target, property) {
      if (property === "observe") {
        return (...args: Parameters<OrbHostProvider["observe"]>) =>
          target.observe(...args).map((observation) =>
            observation === null
              ? null
              : {
                  ...observation,
                  ...(lastStartedAt === undefined
                    ? { lastStartedAt: undefined }
                    : { lastStartedAt }),
                },
          );
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...harness.deps, hostProvider };
}

async function seedStopping(task: SimulationTask, harness: TestHarness): Promise<number> {
  seedRunningOrb(task, harness, ORB);
  const stopped = await requestOrbStop(task, harness.deps, ORB);
  expect(stopped.isOk()).toBe(true);
  if (stopped.isErr()) throw new Error(stopped.error.message);
  return stopped.value.stateChangedAt;
}

async function runEvidenceScenario(
  name: string,
  scenario: (task: SimulationTask, harness: TestHarness) => Promise<void>,
): Promise<void> {
  await runDst({ name, iterations: 30, lateTimerProbability: 0 }, async (sim) => {
    const harness = makeHarness();
    const result = await sim.runTasks([{ name: "driver", f: (task) => scenario(task, harness) }]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
}

describe("drain restart evidence", () => {
  for (const scenario of [
    { name: "missing", timestamp: (_stoppingAt: number) => undefined },
    {
      name: "future",
      timestamp: (stoppingAt: number) => stoppingAt + TEST_CONSTANTS.postRestartGraceMs + 1,
    },
    { name: "before the stopping episode", timestamp: (stoppingAt: number) => stoppingAt - 1 },
  ] as const) {
    it(`does not adopt ${scenario.name} provider start evidence`, async () => {
      await runDst(
        {
          name: `drain-start-${scenario.name.replaceAll(" ", "-")}`,
          iterations: 30,
          lateTimerProbability: 0,
        },
        async (sim) => {
          const harness = makeHarness();
          const result = await sim.runTasks([
            {
              name: "driver",
              f: async (task) => {
                const stoppingAt = await seedStopping(task, harness);
                const deps = withStartedAt(harness, scenario.timestamp(stoppingAt));
                deps.control.noteStateEpisode(ORB, stoppingAt);
                deps.control.resetLivenessBaseline(
                  ORB,
                  task.monotonicNow() - deps.constants.unreachableGraceMs - 1,
                );
                const startsBefore = harness.world.hostStartCountOf(ORB);
                expect(await reconcileOrbOnce(task, deps, ORB)).toEqual({ type: "progressed" });
                expect(harness.world.hostStartCountOf(ORB)).toBe(startsBefore + 1);
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    });
  }

  it("a fresh control plane adopts a provider start at the stopping boundary", async () => {
    await runEvidenceScenario("drain-start-equal-boundary", async (task, harness) => {
      const stoppingAt = await seedStopping(task, harness);
      const restarted = restartControlPlane(harness);
      const deps = withStartedAt(restarted, stoppingAt);
      deps.control.noteStateEpisode(ORB, stoppingAt);
      deps.control.resetLivenessBaseline(
        ORB,
        task.monotonicNow() - deps.constants.unreachableGraceMs - 1,
      );
      const startsBefore = harness.world.hostStartCountOf(ORB);
      expect(await reconcileOrbOnce(task, deps, ORB)).toEqual({
        type: "waiting",
        reason: "readiness",
      });
      expect(harness.world.hostStartCountOf(ORB)).toBe(startsBefore);
      const adopted = deps.control.getLiveness(ORB);
      expect(adopted?.hostStartedAt).toBe(stoppingAt);
      expect(adopted?.restartGraceMs).toBe(TEST_CONSTANTS.postRestartGraceMs);
    });
  });

  it("a successful pull followed by a crash permits one recovery restart", async () => {
    await runEvidenceScenario("drain-start-known-pull-crash", async (task, harness) => {
      const stoppingAt = await seedStopping(task, harness);
      const deps = withStartedAt(harness, stoppingAt);
      deps.control.noteStateEpisode(ORB, stoppingAt);
      deps.control.recordPullSuccess(
        ORB,
        task.monotonicNow(),
        "idle",
        "runtime-before-crash",
        stoppingAt,
      );
      harness.world.killRuntimeProcess(ORB);
      deps.control.resetLivenessBaseline(
        ORB,
        task.monotonicNow() - deps.constants.unreachableGraceMs - 1,
        null,
        stoppingAt,
      );
      const startsBefore = harness.world.hostStartCountOf(ORB);
      expect(await reconcileOrbOnce(task, deps, ORB)).toEqual({ type: "progressed" });
      expect(harness.world.hostStartCountOf(ORB)).toBe(startsBefore + 1);

      await task.sleep(deps.constants.postRestartGraceMs + 1, "expire one recovery restart");
      expect((await reconcileOrbOnce(task, deps, ORB)).type).toBe("transitioned");
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("failed");
      expect(harness.world.hostStartCountOf(ORB)).toBe(startsBefore + 1);
    });
  });

  it("repeated observation of one provider start does not extend its deadline", async () => {
    await runEvidenceScenario("drain-start-fixed-deadline", async (task, harness) => {
      const stoppingAt = await seedStopping(task, harness);
      const deps = withStartedAt(harness, stoppingAt);
      deps.control.noteStateEpisode(ORB, stoppingAt);
      deps.control.resetLivenessBaseline(
        ORB,
        task.monotonicNow() - deps.constants.unreachableGraceMs - 1,
      );
      expect((await reconcileOrbOnce(task, deps, ORB)).type).toBe("waiting");
      const adoptedAt = deps.control.getLiveness(ORB)?.lastSuccessAt;
      harness.world.setPullOutage(task, ORB, TEST_CONSTANTS.postRestartGraceMs);
      await task.sleep(deps.constants.unreachableGraceMs + 1, "observe same start again");
      expect((await reconcileOrbOnce(task, deps, ORB)).type).toBe("waiting");
      expect(deps.control.getLiveness(ORB)?.lastSuccessAt).toBe(adoptedAt);
    });
  });
});
