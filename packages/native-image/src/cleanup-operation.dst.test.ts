import type { SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../../../apps/control-plane/src/testkit/sim.ts";
import type { CleanupEvidence } from "./cleanup-evidence.ts";
import { type CleanupTiming, type CommandRunner, GcloudImageBuildEffects } from "./gcloud.ts";
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

const image = "pi-orb-image-v1-0123456789abcdef";
const target = `projects/target-project/global/images/${image}`;
const operation = "exact-delete";

const timing = (task: SimulationTask): CleanupTiming => ({
  now: () => task.monotonicNow(),
  wait: async (milliseconds, signal) =>
    task.sleep(milliseconds, "wait for submitted cleanup operation", {
      signal,
    }),
});

describe("cleanup operation cancellation under deterministic scheduling", () => {
  it("durably retains the acknowledged operation when cancellation races polling", async () => {
    await runDst(
      {
        name: "native-cleanup-post-receipt-cancellation",
        iterations: 20,
        lateTimerProbability: 0,
      },
      async (sim) => {
        const controller = new AbortController();
        const evidence: CleanupEvidence[] = [];
        let polling = false;
        let cleanupError: unknown;
        const schedule = await sim.runTasks([
          {
            name: "cleanup",
            f: async (task) => {
              const runner: CommandRunner = async (_command, args) => {
                await task.checkpoint("cleanup command", ...args.slice(0, 4));
                if (args[1] === "operations" && args[2] === "list")
                  return { stdout: "[]", stderr: "" };
                if (args[1] === "images" && args[2] === "describe")
                  return {
                    stdout: JSON.stringify({
                      name: image,
                      labels: { "pi-orb-native-build": input.operationId },
                    }),
                    stderr: "",
                  };
                if (args[1] === "operations" && args[2] === "describe") {
                  polling = true;
                  await task.checkpoint("submitted operation polled");
                  return {
                    stdout: JSON.stringify({
                      name: operation,
                      status: "RUNNING",
                      targetLink: target,
                      selfLink: `projects/target-project/global/operations/${operation}`,
                    }),
                    stderr: "",
                  };
                }
                throw new Error(`unexpected command: ${args.join(" ")}`);
              };
              const result = await new GcloudImageBuildEffects(
                runner,
                timing(task),
                () => okAsync(undefined),
                (entry) => {
                  evidence.push(entry);
                  return okAsync(undefined);
                },
                () =>
                  okAsync({
                    name: operation,
                    operationType: "delete",
                    status: "RUNNING",
                    targetLink: target,
                    selfLink: `projects/target-project/global/operations/${operation}`,
                  }),
              ).run("cleanup", "delete-image", input, controller.signal);
              cleanupError = result.isErr() ? result.error : undefined;
            },
          },
          {
            name: "cancel",
            f: async (task) => {
              while (!polling) await task.sleep(1, "cancellation waits for polling");
              controller.abort();
            },
          },
        ]);

        expect(schedule.isOk(), schedule.isErr() ? schedule.error.message : "").toBe(true);
        expect(cleanupError).toMatchObject({ type: "cancelled" });
        expect(evidence).toContainEqual({
          resourceKind: "images",
          target,
          scope: "global",
          operation,
          status: "submitted",
          errorCode: null,
        });
        expect(evidence.at(-1)).toMatchObject({
          operation,
          status: "uncertain",
          errorCode: "CANCELLED",
        });
      },
    );
  });
});
