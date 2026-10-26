import { mkdirSync, writeFileSync } from "node:fs";
import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { centralWorkHarness, deferred, nativeDeadlineTask } from "../testkit/central-work.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";

type Command =
  | "submit"
  | "poll"
  | "reconcile"
  | "progress"
  | "restart"
  | "idle"
  | "wait"
  | "submit-second";
type Harness = Awaited<ReturnType<typeof centralWorkHarness>>;
const firstSeed = Number(process.env["CENTRAL_WORK_CAMPAIGN_FIRST_SEED"] ?? 0);

/** Independent worker quanta, not a combined poll/reconcile transaction. */
async function execute(task: SimulationTask, owner: SimulationTask, h: Harness, command: Command) {
  h.command(command);
  await task.checkpoint("central work command", command);
  switch (command) {
    case "submit":
      // Repeated submit exercises idempotency under the original identity.
      await h.submit(task, "00000000-0000-4000-8000-000000000081");
      break;
    case "submit-second":
      await h.submit(task, "00000000-0000-4000-8000-000000000082");
      break;
    case "wait":
      await task.sleep(10_000, "worker pause");
      break;
    case "poll":
      await h.poll(task);
      break;
    case "reconcile":
      await h.reconcile(task);
      break;
    case "progress":
      h.release();
      break;
    case "restart":
      await h.restart(owner);
      break;
    case "idle": {
      const until = task.monotonicNow() + 50_000;
      while (task.monotonicNow() < until) {
        await h.tick(task);
        await task.sleep(500, "idle");
      }
      break;
    }
  }
  // Observe identities and safety before any subsequent restart, never to
  // choose a command. Reads do not open a Harness or trigger recovery.
  return h.inspect(task);
}

function program(task: SimulationTask, restarts: boolean, faults: boolean): Command[] {
  const choices: Command[] = [
    "submit",
    "poll",
    "poll",
    "reconcile",
    "progress",
    "idle",
    ...(faults ? ["submit-second" as const, "wait" as const, "wait" as const] : []),
    ...(restarts ? ["restart" as const, "restart" as const] : []),
  ];
  return [
    "submit",
    ...Array.from({ length: faults ? 16 : 8 }, () => {
      const choice =
        choices[Math.floor(task.random("central work command choice") * choices.length)];
      if (choice === undefined) throw new Error("command entropy out of range");
      return choice;
    }),
  ];
}

for (const mode of ["running", "idle", "database-stalls", "database-visibility"] as const) {
  const idle = mode === "idle";
  const faults = mode === "database-stalls";
  const visibility = mode === "database-visibility";
  const seedCount = Number(process.env["CENTRAL_WORK_CAMPAIGN_SEEDS"] ?? (visibility ? 8 : 4));
  for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
    it(`central work campaign ${mode} seed=${seed}`, async ({ signal }) => {
      const logs = new LogCapture();
      await runDst(
        {
          name: `central-work-${mode}-${seed}`,
          seed,
          signal,
          iterations: 1,
          logCapture: logs,
          lateTimerProbability: 0,
        },
        async (sim) => {
          const h = await centralWorkHarness();
          const ready = deferred(),
            finished = deferred();
          const environmentStart = deferred(),
            environmentDone = deferred();
          const historyDone = deferred(),
            modelDone = deferred();
          let stopHistory = false;
          let owner!: SimulationTask;
          const observations: unknown[] = [];
          const historyOutcomes: Awaited<ReturnType<Harness["pollHistory"]>>[] = [];
          let completed = false;
          const evidence = () => {
            mkdirSync("test-failures", { recursive: true });
            writeFileSync(
              `test-failures/central-work-${mode}-${seed}-state-${Date.now()}.json`,
              JSON.stringify({ observations, historyOutcomes, lifecycle: logs.lines() }, null, 2),
            );
          };
          const result = await sim.runTasks([
            {
              name: "lease-renewal",
              f: async (task) => {
                owner = task;
                ready.resolve();
                // Only PgAgentPersistence's heartbeat invokes APIs on this task.
                await finished.promise;
              },
            },
            {
              name: "database-environment",
              f: async (task) => {
                // Generated without observing commands, SQL, ownership or outcomes.
                const episodes = faults
                  ? Array.from({ length: 2 }, () => ({
                      healthy: 500 + Math.floor(task.random("database healthy duration") * 10_000),
                      stalled: 500 + Math.floor(task.random("database stalled duration") * 120_000),
                    }))
                  : [];
                const latencies = visibility
                  ? Array.from({ length: 256 }, () => {
                      const choice = task.random("database delivery phase");
                      const ms = 100 + Math.floor(task.random("database delivery latency") * 1400);
                      return choice < 0.5
                        ? null
                        : {
                            phase: choice < 0.75 ? ("admission" as const) : ("completion" as const),
                            ms,
                          };
                    })
                  : [];
                await environmentStart.promise;
                h.command(`database episodes:${JSON.stringify({ episodes, latencies })}`);
                for (const episode of episodes) {
                  await task.sleep(episode.healthy, "database healthy interval");
                  h.databaseStall(true);
                  await task.sleep(episode.stalled, "database stalled interval");
                  h.databaseStall(false);
                }
                if (visibility) {
                  h.databaseLatencyPlan(latencies);
                  await h.serveDatabaseReplies(task);
                }
                environmentDone.resolve();
              },
            },
            {
              name: "model-environment",
              f: async (task) => {
                const releaseAt = Math.floor(task.random("model release delay") * 30_000);
                await environmentStart.promise;
                if (visibility) {
                  h.command(`model release after:${releaseAt}`);
                  await task.sleep(releaseAt, "model environment hold");
                  h.release();
                }
                modelDone.resolve();
              },
            },
            {
              name: "history-worker",
              f: async (simulationTask) => {
                const task = nativeDeadlineTask(simulationTask);
                await environmentStart.promise;
                try {
                  while (visibility && !stopHistory) {
                    historyOutcomes.push(await h.pollHistory(task));
                    await task.sleep(h.historyIntervalMs, "independent history cadence");
                  }
                } finally {
                  historyDone.resolve();
                }
              },
            },
            {
              name: "commands-and-workers",
              f: async (simulationTask) => {
                const task = nativeDeadlineTask(simulationTask);
                await ready.promise;
                let initialState: Awaited<ReturnType<Harness["inspect"]>> | undefined;
                const observe = (state: Awaited<ReturnType<Harness["inspect"]>>) => {
                  observations.push(state);
                  if (observations.length > 12) observations.shift();
                  const done = h.complete(state);
                  if (visibility && initialState) {
                    expect(
                      logs.matching("to=failed"),
                      "healthy dependencies never fail execution",
                    ).toEqual([]);
                    expect(
                      logs.matching("compute-discard-requested"),
                      "healthy dependencies never authorize disposal",
                    ).toEqual([]);
                    expect(
                      historyOutcomes,
                      "healthy source never reports integrity failure",
                    ).not.toContainEqual(expect.objectContaining({ type: "integrity" }));
                    expect(state.orb?.state, "healthy dependencies cannot fail the orb").not.toBe(
                      "failed",
                    );
                    expect(
                      state.orb?.runtimeTokenHash,
                      "healthy dependencies preserve authorization",
                    ).toBe(initialState.orb?.runtimeTokenHash);
                    expect(
                      state.orb?.hostDiscardThroughIncarnation,
                      "healthy dependencies cannot authorize disposal",
                    ).toBeNull();
                  }
                  return done;
                };
                try {
                  await h.initialize(task, owner);
                  if (idle) {
                    const state = await execute(task, owner, h, "idle");
                    observe(state);
                    expect(state.orb?.state, "idle reaches stopped compute").toBe("stopped");
                  }
                  // Seed 0 also supplies a no-restart control. Every command is
                  // generated before execution, independent of inspected state.
                  const commands = program(
                    task,
                    !faults && !visibility && seed !== 0,
                    faults || visibility,
                  );
                  h.command(JSON.stringify(commands));
                  // Establish a non-vacuous acknowledged obligation before faults.
                  const initial = await execute(task, owner, h, "submit");
                  expect(initial.accepted.length, "campaign has accepted work").toBeGreaterThan(0);
                  observe(initial);
                  initialState = initial;
                  environmentStart.resolve();
                  for (const command of commands) {
                    const state = await execute(task, owner, h, command);
                    observe(state);
                  }
                  await modelDone.promise;
                  h.finishDatabaseLatency();
                  await environmentDone.promise;
                  h.databaseStall(false);
                  // Fair suffix: no new inputs, restarts, faults, Start, or direct open.
                  h.release();
                  // Covers an outstanding 60s lease plus normal loop retries.
                  const deadline = task.monotonicNow() + (faults ? 90_000 : 15_000);
                  completed = observe(await h.inspect(task));
                  while (task.monotonicNow() < deadline && !completed) {
                    await h.tick(task);
                    await task.sleep(500, "fair suffix");
                    completed = observe(await h.inspect(task));
                  }
                  if (faults) {
                    expect(observations.at(-1)).toMatchObject({ generation: 0 });
                  }
                  if (!completed) evidence();
                  expect(completed, "accepted work completes under its original identity").toBe(
                    true,
                  );
                } catch (error) {
                  evidence();
                  throw error;
                } finally {
                  try {
                    environmentStart.resolve();
                    await modelDone.promise;
                    h.finishDatabaseLatency();
                    await environmentDone.promise;
                    h.databaseStall(false);
                    h.deliverDatabaseReplies(true);
                    h.release();
                    stopHistory = true;
                    await historyDone.promise;
                    const finalState = completed ? await h.inspect(task) : null;
                    const cleanup = await h.close();
                    if (!completed || Object.values(cleanup).some((error) => error !== null)) {
                      observations.push({ cleanup });
                      evidence();
                    }
                    if (completed) {
                      if (finalState)
                        expect(observe(finalState), "joined workers preserve completed work").toBe(
                          true,
                        );
                      expect(cleanup, "healthy cleanup").toEqual({
                        plane: null,
                        persistence: null,
                        client: null,
                      });
                    }
                  } finally {
                    finished.resolve();
                  }
                }
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    });
  }
}
