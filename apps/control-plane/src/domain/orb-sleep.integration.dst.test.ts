import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { reconcileAllOnce, reconcileLoop } from "./loops.ts";

const ORB = "orb-sleep-scheduler";

describe("scheduled sleep integration (DST)", () => {
  it("does not let an active sleep deadline unpark an invariant", async () => {
    await runDst({ name: "sleep-invariant-remains-parked", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "scheduler",
          f: async (task) => {
            harness.store.seedProject(makeProjectRow(`project-of-${ORB}`));
            harness.store.seedOrb(
              makeOrbRow(ORB, `project-of-${ORB}`, "stopped", {
                sleepId: "00000000-0000-4000-8000-000000000052",
                sleepUntil: task.wallNow() + 1_000,
              }),
            );
            harness.store.failWithInvariant("getOrb");
            await reconcileAllOnce(task, harness.deps);
            await task.checkpoint("invariant parked before sleep deadline");
            expect(harness.deps.control.getNextAttemptAt(`reconcile:${ORB}`)).toBe(
              Number.POSITIVE_INFINITY,
            );
            await task.sleep(1_000, "cross parked sleep deadline");
            await reconcileAllOnce(task, harness.deps);
            expect(harness.deps.control.getNextAttemptAt(`reconcile:${ORB}`)).toBe(
              Number.POSITIVE_INFINITY,
            );
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("observes a wall-clock jump past a sleep deadline on the next scan", async () => {
    await runDst({ name: "sleep-wall-forward-jump", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { hostBackstopIntervalMs: 300_000 } });
      let wallOffset = 0;
      const clock = (task: SimulationTask): SimulationTask =>
        new Proxy(task, {
          get(target, key) {
            if (key === "wallNow") return () => target.wallNow() + wallOffset;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      const result = await sim.runTasks([
        {
          name: "scheduler",
          f: async (rawTask) => {
            const task = clock(rawTask);
            harness.store.seedProject(makeProjectRow(`project-of-${ORB}`));
            harness.store.seedOrb(
              makeOrbRow(ORB, `project-of-${ORB}`, "stopped", {
                sleepId: "00000000-0000-4000-8000-000000000053",
                sleepUntil: task.wallNow() + 120_000,
              }),
            );
            await reconcileAllOnce(task, harness.deps);
            await task.checkpoint("normal terminal backstop scheduled before wall jump");
            wallOffset = 180_000;
            await reconcileAllOnce(task, harness.deps);
            expect(harness.store.messageSnapshots(ORB)).toHaveLength(1);
            expect(harness.store.messageSnapshots(ORB)[0]?.system?.kind).toBe("sleep_wake");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("advances a terminal backstop to an earlier sleep deadline", async () => {
    await runDst(
      {
        name: "sleep-terminal-backstop-deadline",
        iterations: 20,
        lateTimerProbability: 0,
      },
      async (sim) => {
        const tickMs = 500;
        const harness = makeHarness({
          constants: { reconcileTickMs: tickMs, hostBackstopIntervalMs: 30_000 },
        });
        const stop = new AbortController();
        let seeded = false;
        let deadline = 0;
        const result = await sim.runTasks([
          {
            name: "reconciler",
            f: async (task) => {
              await waitUntil(task, "terminal sleeper seeded", () => seeded, { intervalMs: 1 });
              await reconcileLoop(task, harness.deps, stop.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              deadline = task.wallNow() + 5_000;
              harness.store.seedProject(makeProjectRow(`project-of-${ORB}`));
              harness.store.seedOrb(
                makeOrbRow(ORB, `project-of-${ORB}`, "stopped", {
                  sleepId: "00000000-0000-4000-8000-000000000051",
                  sleepUntil: deadline,
                  stateChangedAt: task.wallNow(),
                }),
              );
              seeded = true;

              await waitUntil(
                task,
                "sleep wake queued",
                () => harness.store.messageSnapshots(ORB).length === 1,
                { intervalMs: tickMs, timeoutMs: 31_000 },
              );
              const notice = harness.store.messageSnapshots(ORB)[0];
              expect(notice?.createdAt).toBeGreaterThanOrEqual(deadline);
              expect(notice?.createdAt).toBeLessThanOrEqual(deadline + tickMs);
              expect(notice).toMatchObject({
                messageId: "00000000-0000-4000-8000-000000000051",
                system: { kind: "sleep_wake" },
                autoStart: true,
              });
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
});
