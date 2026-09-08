import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { runDst } from "../../../apps/control-plane/src/testkit/sim.ts";
import { type CommandRunner, GcloudImageBuildEffects } from "./gcloud.ts";
import type { ImageBuildInput } from "./orchestrator.ts";

const baseInput: Omit<ImageBuildInput, "outputDir"> = {
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
};

const timing = (task: SimulationTask) => ({
  now: () => task.monotonicNow(),
  wait: async (milliseconds: number, signal: AbortSignal) =>
    task.sleep(milliseconds, "wait for exact cloud operation", { signal }),
});

async function withOutputDir(f: (input: ImageBuildInput) => Promise<void>): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), "pi-orb-native-image-dst-"));
  try {
    await f({ ...baseInput, outputDir });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

describe("GCloud cleanup under deterministic scheduling", () => {
  it("waits for an independently completing exact create and ignores a foreign operation", async () => {
    await withOutputDir(async (input) =>
      runDst({ name: "native-image-late-create-cleanup", iterations: 20 }, async (sim) => {
        let listed = false;
        let operationDone = false;
        let materialized = false;
        let deleted = false;
        let cleanupFinished = false;
        const describedOperations: string[] = [];
        const image = "pi-orb-image-workspace-v1-0123456789abcdef";
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
              try {
                const result = await new GcloudImageBuildEffects(runner, timing(task)).run(
                  "cleanup",
                  "delete-workspace-image",
                  input,
                  new AbortController().signal,
                );
                expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
              } finally {
                cleanupFinished = true;
              }
            },
          },
          {
            name: "cloud-create",
            f: async (task) => {
              while (!listed) await task.checkpoint("create waits until cleanup lists operations");
              await task.checkpoint("late create completes");
              materialized = true;
              operationDone = true;
              while (!cleanupFinished)
                await task.checkpoint("cloud remains observable during cleanup");
            },
          },
        ]);
        expect(schedule.isOk(), schedule.isErr() ? schedule.error.message : "").toBe(true);
        expect(describedOperations.every((name) => name === "exact-create")).toBe(true);
        expect(describedOperations.length).toBeGreaterThan(0);
        expect(deleted).toBe(true);
      }),
    );
  });

  it("fails visibly when an exact operation never completes within the cleanup budget", async () => {
    await withOutputDir(async (input) =>
      runDst({ name: "native-image-operation-timeout", iterations: 10 }, async (sim) => {
        let cleanupFinished = false;
        const schedule = await sim.runTasks([
          {
            name: "cleanup",
            f: async (task) => {
              const runner: CommandRunner = async (_command, args) => {
                await task.checkpoint("gcloud cleanup command", ...args.slice(0, 4));
                if (args[1] === "operations" && args[2] === "list") {
                  return {
                    stdout: JSON.stringify([
                      {
                        name: "stuck-create",
                        status: "RUNNING",
                        targetLink:
                          "projects/target-project/global/images/pi-orb-image-workspace-v1-0123456789abcdef",
                      },
                    ]),
                    stderr: "",
                  };
                }
                if (args[1] === "operations" && args[2] === "describe")
                  return { stdout: "RUNNING\n", stderr: "" };
                throw new Error(`unexpected command: ${args.join(" ")}`);
              };
              try {
                const result = await new GcloudImageBuildEffects(runner, timing(task)).run(
                  "cleanup",
                  "delete-workspace-image",
                  input,
                  new AbortController().signal,
                );
                expect(result.isErr() && result.error.message).toContain(
                  "timed out waiting for cleanup operation stuck-create",
                );
              } finally {
                cleanupFinished = true;
              }
            },
          },
          {
            name: "cloud-operation",
            f: async (task) => {
              while (!cleanupFinished)
                await task.sleep(1_000, "stuck cloud operation remains observable");
            },
          },
        ]);
        expect(schedule.isOk(), schedule.isErr() ? schedule.error.message : "").toBe(true);
      }),
    );
  });
});
