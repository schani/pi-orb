import type { SimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../../../apps/control-plane/src/testkit/sim.ts";
import { type CommandLogWriter, type CommandRunner, GcloudImageBuildEffects } from "./gcloud.ts";
import type { ImageBuildInput } from "./orchestrator.ts";

const input: ImageBuildInput = {
  project: "target-project",
  zone: "us-central1-a",
  baseImage: "projects/base/global/images/base",
  version: "v1",
  subnetwork: "subnet",
  builderServiceAccount: "builder@example.com",
  validationServiceAccount: "validator@example.com",
  sourceCommit: "a".repeat(40),
  sourceDirty: false,
  sourceArchiveSha256: "b".repeat(64),
  operationId: "0123456789abcdef",
  validationRepositoryUrl: "https://github.com/example/repo",
  inputInventory: {},
  toolingInputInventory: {},
  outputDir: "/sim/native-image",
};

const timing = (task: SimulationTask) => ({
  now: () => task.monotonicNow(),
  wait: async (milliseconds: number, signal: AbortSignal) =>
    task.sleep(milliseconds, "wait for exact cloud operation", { signal }),
});

const logWriter =
  (task: SimulationTask, written: string[], delay: number): CommandLogWriter =>
  (path, contents) =>
    ResultAsync.fromPromise(
      (async () => {
        await task.checkpoint("command log persistence requested");
        if (delay > 0) await task.sleep(delay, "command log persistence completes");
        written.push(`${path}\n${contents}`);
      })(),
      () => ({ type: "command_log_write_failed", message: "simulated log write failed" }),
    );

const image = "pi-orb-image-workspace-v1-0123456789abcdef";

describe("GCloud cleanup under deterministic scheduling", () => {
  for (const logDelay of [0, 25]) {
    it(`waits for an independently completing exact create with ${logDelay}ms log persistence`, async () => {
      await runDst(
        {
          name: `native-image-late-create-cleanup-log-${logDelay}`,
          iterations: 20,
          lateTimerProbability: 0,
        },
        async (sim) => {
          let listed = false;
          let operationDone = false;
          let materialized = false;
          let deleted = false;
          const describedOperations: string[] = [];
          const logs: string[] = [];
          const schedule = await sim.runTasks([
            {
              name: "cleanup",
              f: async (task) => {
                const runner: CommandRunner = async (_command, args) => {
                  await task.checkpoint("gcloud cleanup command", ...args.slice(0, 4));
                  if (args[1] === "operations" && args[2] === "list") {
                    listed = true;
                    return {
                      stdout: JSON.stringify([
                        {
                          name: "exact-create",
                          status: "RUNNING",
                          targetLink: `projects/target-project/global/images/${image}`,
                        },
                        {
                          name: "foreign-create",
                          status: "RUNNING",
                          targetLink: `projects/other/global/images/${image}`,
                        },
                      ]),
                      stderr: "",
                    };
                  }
                  if (args[1] === "operations" && args[2] === "describe") {
                    describedOperations.push(String(args[3]));
                    return { stdout: operationDone ? "DONE\n" : "RUNNING\n", stderr: "" };
                  }
                  if (args[1] === "images" && args[2] === "describe") {
                    if (!materialized) throw new Error(`${image} was not found`);
                    return {
                      stdout: JSON.stringify({
                        name: image,
                        labels: { "pi-orb-native-build": input.operationId },
                      }),
                      stderr: "",
                    };
                  }
                  if (args[1] === "images" && args[2] === "delete") {
                    expect(operationDone).toBe(true);
                    expect(materialized).toBe(true);
                    deleted = true;
                    return { stdout: "", stderr: "" };
                  }
                  throw new Error(`unexpected command: ${args.join(" ")}`);
                };
                const result = await new GcloudImageBuildEffects(
                  runner,
                  timing(task),
                  logWriter(task, logs, logDelay),
                ).run("cleanup", "delete-workspace-image", input, new AbortController().signal);
                expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
              },
            },
            {
              name: "cloud-create",
              f: async (task) => {
                while (!listed)
                  await task.checkpoint("create waits until cleanup lists operations");
                await task.checkpoint("late create completes");
                materialized = true;
                operationDone = true;
                // Resource state persists after this task completes; keeping a
                // runnable observer alive would starve virtual-time progress.
              },
            },
          ]);
          expect(schedule.isOk(), schedule.isErr() ? schedule.error.message : "").toBe(true);
          expect(describedOperations.every((name) => name === "exact-create")).toBe(true);
          expect(describedOperations.length).toBeGreaterThan(0);
          expect(deleted).toBe(true);
          expect(logs.some((entry) => entry.includes("images delete"))).toBe(true);
        },
      );
    });
  }

  it("fails visibly when an exact operation never completes within the cleanup budget", async () => {
    await runDst(
      { name: "native-image-operation-timeout", iterations: 10, lateTimerProbability: 0 },
      async (sim) => {
        const schedule = await sim.runTasks([
          {
            name: "cleanup",
            f: async (task) => {
              const waitStarts: number[] = [];
              const runner: CommandRunner = async (_command, args) => {
                await task.checkpoint("gcloud cleanup command", ...args.slice(0, 4));
                if (args[1] === "operations" && args[2] === "list") {
                  return {
                    stdout: JSON.stringify([
                      {
                        name: "stuck-create",
                        status: "RUNNING",
                        targetLink: `projects/target-project/global/images/${image}`,
                      },
                    ]),
                    stderr: "",
                  };
                }
                if (args[1] === "operations" && args[2] === "describe") {
                  await task.sleep(10_000, "slow operation status command");
                  return { stdout: "RUNNING\n", stderr: "" };
                }
                throw new Error(`unexpected command: ${args.join(" ")}`);
              };
              const result = await new GcloudImageBuildEffects(
                runner,
                {
                  now: () => task.monotonicNow(),
                  wait: async (milliseconds, signal) => {
                    waitStarts.push(task.monotonicNow());
                    await task.sleep(milliseconds, "wait for exact cloud operation", { signal });
                  },
                },
                logWriter(task, [], 0),
              ).run("cleanup", "delete-workspace-image", input, new AbortController().signal);
              expect(result.isErr() && result.error.message).toContain(
                "timed out waiting for cleanup operation stuck-create",
              );
              expect(waitStarts.every((startedAt) => startedAt < 60_000)).toBe(true);
            },
          },
        ]);
        expect(schedule.isOk(), schedule.isErr() ? schedule.error.message : "").toBe(true);
      },
    );
  });

  it("does not hide command-log persistence failure or proceed with deletion", async () => {
    let commands = 0;
    const runner: CommandRunner = async () => {
      commands++;
      return { stdout: "[]", stderr: "" };
    };
    const result = await new GcloudImageBuildEffects(runner, undefined, () =>
      errAsync({ type: "command_log_write_failed", message: "storage unavailable" }),
    ).run("cleanup", "delete-workspace-image", input, new AbortController().signal);
    expect(result.isErr() && result.error.message).toContain(
      "failed to preserve command log: storage unavailable",
    );
    expect(commands).toBe(1);
  });
});
