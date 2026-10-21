import { mkdirSync, writeFileSync } from "node:fs";
import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { centralWorkHarness, deferred, nativeDeadlineTask } from "../testkit/central-work.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";

type Command = "submit" | "poll" | "reconcile" | "progress" | "restart" | "idle";
type Harness = Awaited<ReturnType<typeof centralWorkHarness>>;
const firstSeed = Number(process.env["CENTRAL_WORK_CAMPAIGN_FIRST_SEED"] ?? 0);
const seedCount = Number(process.env["CENTRAL_WORK_CAMPAIGN_SEEDS"] ?? 4);

/** Independent worker quanta, not a combined poll/reconcile transaction. */
async function execute(task: SimulationTask, owner: SimulationTask, h: Harness, command: Command) {
  h.command(command);
  await task.checkpoint("central work command", command);
  switch (command) {
    case "submit":
      // Repeated submit exercises idempotency under the original identity.
      await h.submit(task, "00000000-0000-4000-8000-000000000081");
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

function program(task: SimulationTask, restarts: boolean): Command[] {
  const choices: Command[] = [
    "submit",
    "poll",
    "poll",
    "reconcile",
    "progress",
    "idle",
    ...(restarts ? ["restart" as const, "restart" as const] : []),
  ];
  return [
    "submit",
    ...Array.from({ length: 8 }, () => {
      const choice =
        choices[Math.floor(task.random("central work command choice") * choices.length)];
      if (choice === undefined) throw new Error("command entropy out of range");
      return choice;
    }),
  ];
}

for (const idle of [false, true]) {
  for (let seed = firstSeed; seed < firstSeed + seedCount; seed++) {
    it(`central work campaign idle=${idle} seed=${seed}`, async () => {
      const logs = new LogCapture();
      await runDst(
        {
          name: `central-work-${idle}-${seed}`,
          seed,
          iterations: 1,
          logCapture: logs,
          lateTimerProbability: 0,
        },
        async (sim) => {
          const h = await centralWorkHarness();
          const ready = deferred(),
            finished = deferred();
          let owner!: SimulationTask;
          const observations: unknown[] = [];
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
              name: "commands-and-workers",
              f: async (simulationTask) => {
                const task = nativeDeadlineTask(simulationTask);
                await ready.promise;
                const observe = (state: Awaited<ReturnType<Harness["inspect"]>>) => {
                  observations.push(state);
                  return h.complete(state);
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
                  const commands = program(task, seed !== 0);
                  h.command(JSON.stringify(commands));
                  for (const command of commands) {
                    observe(await execute(task, owner, h, command));
                  }
                  // Fair suffix: no new inputs, restarts, faults, Start, or direct open.
                  h.release();
                  const deadline = task.monotonicNow() + 15_000;
                  let completed = observe(await h.inspect(task));
                  while (task.monotonicNow() < deadline && !completed) {
                    await h.tick(task);
                    await task.sleep(500, "fair suffix");
                    completed = observe(await h.inspect(task));
                  }
                  if (!completed) {
                    mkdirSync("test-failures", { recursive: true });
                    writeFileSync(
                      `test-failures/central-work-${idle}-${seed}-state-${Date.now()}.json`,
                      JSON.stringify({ observations, final: observations.at(-1) }, null, 2),
                    );
                  }
                  expect(completed, "accepted work completes under its original identity").toBe(
                    true,
                  );
                } finally {
                  try {
                    await h.close();
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
