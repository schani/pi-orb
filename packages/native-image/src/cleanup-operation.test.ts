import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import { type CleanupEvidence, fileCleanupEvidenceWriter } from "./cleanup-evidence.ts";
import { type CleanupTiming, GcloudImageBuildEffects } from "./gcloud.ts";
import { buildNativeImage, type ImageBuildInput } from "./orchestrator.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function input(): Promise<ImageBuildInput> {
  const outputDir = await mkdtemp(join(tmpdir(), "cleanup-operation-"));
  directories.push(outputDir);
  return {
    project: "target-project",
    zone: "us-central1-a",
    baseImage: "projects/base-project/global/images/debian-pinned",
    version: "v1",
    subnetwork: "projects/target-project/regions/us-central1/subnetworks/orbs",
    builderServiceAccount: "builder@target-project",
    validationServiceAccount: "orb@target-project",
    sourceCommit: "a".repeat(40),
    sourceDirty: false,
    sourceArchiveSha256: "b".repeat(64),
    operationId: "0123456789abcdef",
    outputDir,
    validationRepositoryUrl: "https://github.com/example/repo",
    inputInventory: {},
    toolingInputInventory: {},
  };
}

const image = "pi-orb-image-v1-0123456789abcdef";
const target = `projects/target-project/global/images/${image}`;
const operation = "delete-image-operation";

function cleanupRunner(status: "RUNNING" | "DONE" = "DONE") {
  return async (_command: string, args: string[]) => {
    if (args[1] === "operations" && args[2] === "list") return { stdout: "[]", stderr: "" };
    if (args[1] === "operations" && args[2] === "describe")
      return {
        stdout: JSON.stringify({
          name: operation,
          status,
          targetLink: target,
          selfLink: `projects/target-project/global/operations/${operation}`,
        }),
        stderr: "",
      };
    return {
      stdout: JSON.stringify({
        name: image,
        labels: { "pi-orb-native-build": "0123456789abcdef" },
      }),
      stderr: "",
    };
  };
}

const receipt = () =>
  okAsync({
    name: operation,
    operationType: "delete",
    status: "RUNNING",
    targetLink: target,
    selfLink: `projects/target-project/global/operations/${operation}`,
  });

describe("cleanup operation evidence", () => {
  it("deletes an owned partial resource after its failed predecessor retires", async () => {
    const predecessor = "failed-create-operation";
    const written: CleanupEvidence[] = [];
    let submitted = false;
    const effects = new GcloudImageBuildEffects(
      async (_command, args) => {
        if (args[1] === "operations" && args[2] === "list")
          return {
            stdout: JSON.stringify([{ name: predecessor, status: "RUNNING", targetLink: target }]),
            stderr: "",
          };
        if (args[1] === "operations" && args[2] === "describe")
          return {
            stdout: JSON.stringify({
              name: args[3],
              status: "DONE",
              targetLink: target,
              selfLink: `projects/target-project/global/operations/${args[3]}`,
              ...(args[3] === predecessor
                ? { error: { errors: [{ code: "RESOURCE_ERROR" }] } }
                : {}),
            }),
            stderr: "",
          };
        return {
          stdout: JSON.stringify({
            name: image,
            labels: { "pi-orb-native-build": "0123456789abcdef" },
          }),
          stderr: "",
        };
      },
      undefined,
      undefined,
      (entry) => {
        written.push(entry);
        return okAsync(undefined);
      },
      () => {
        submitted = true;
        return receipt();
      },
    );

    const result = await effects.run(
      "cleanup",
      "delete-image",
      await input(),
      new AbortController().signal,
    );

    expect(result.isOk()).toBe(true);
    expect(submitted).toBe(true);
    expect(written).toContainEqual({
      resourceKind: "images",
      target,
      scope: "global",
      operation: predecessor,
      status: "uncertain",
      errorCode: "PREDECESSOR_RUNNING",
    });
    expect(written.at(-1)).toMatchObject({ operation, status: "succeeded" });
  });

  it("maps a null predecessor description to a typed failure", async () => {
    const predecessor = "create-operation";
    const effects = new GcloudImageBuildEffects(async (_command, args) => {
      if (args[1] === "operations" && args[2] === "list")
        return {
          stdout: JSON.stringify([{ name: predecessor, status: "RUNNING", targetLink: target }]),
          stderr: "",
        };
      if (args[1] === "operations" && args[2] === "describe") return { stdout: "null", stderr: "" };
      throw new Error("must not inspect or delete the target");
    });

    const result = await effects.run(
      "cleanup",
      "delete-image",
      await input(),
      new AbortController().signal,
    );

    expect(result.isErr() && result.error).toMatchObject({
      type: "image_build_failed",
      stage: "cleanup",
      message: `invalid cleanup operation ${predecessor}`,
    });
  });

  it("does not submit DELETE when initial evidence persistence fails", async () => {
    let submitted = false;
    const effects = new GcloudImageBuildEffects(
      cleanupRunner(),
      undefined,
      undefined,
      () =>
        errAsync({
          type: "cleanup_evidence_write_failed",
          message: "injected evidence failure",
        }),
      () => {
        submitted = true;
        return receipt();
      },
    );

    const result = await effects.run(
      "cleanup",
      "delete-image",
      await input(),
      new AbortController().signal,
    );

    expect(result.isErr() && result.error.message).toBe("injected evidence failure");
    expect(submitted).toBe(false);
  });

  it("best-effort retains the exact operation when receipt persistence fails", async () => {
    const written: CleanupEvidence[] = [];
    let failedReceipt = false;
    let polls = 0;
    const effects = new GcloudImageBuildEffects(
      async (command, args) => {
        if (args[1] === "operations" && args[2] === "describe") polls++;
        return cleanupRunner()(command, args);
      },
      undefined,
      undefined,
      (entry) => {
        if (entry.status === "submitted" && !failedReceipt) {
          failedReceipt = true;
          return errAsync({
            type: "cleanup_evidence_write_failed",
            message: "receipt persistence failed",
          });
        }
        written.push(entry);
        return okAsync(undefined);
      },
      receipt,
    );

    const result = await effects.run(
      "cleanup",
      "delete-image",
      await input(),
      new AbortController().signal,
    );

    expect(result.isErr() && result.error.message).toBe("receipt persistence failed");
    expect(polls).toBe(0);
    expect(written.at(-1)).toMatchObject({
      operation,
      status: "uncertain",
      errorCode: "POLL_FAILED",
    });
  });

  it("retains the exact operation and cancellation after receipt persistence", async () => {
    const written: CleanupEvidence[] = [];
    const controller = new AbortController();
    const timing: CleanupTiming = {
      now: () => 0,
      wait: async () => {
        controller.abort();
        throw new Error("cancelled wait");
      },
    };
    const effects = new GcloudImageBuildEffects(
      cleanupRunner("RUNNING"),
      timing,
      undefined,
      (entry) => {
        written.push(entry);
        return okAsync(undefined);
      },
      receipt,
    );

    const result = await effects.run("cleanup", "delete-image", await input(), controller.signal);

    expect(result.isErr() && result.error.type).toBe("cancelled");
    expect(written).toContainEqual({
      resourceKind: "images",
      target,
      scope: "global",
      operation,
      status: "submitted",
      errorCode: null,
    });
    expect(written.at(-1)).toMatchObject({
      operation,
      status: "uncertain",
      errorCode: "CANCELLED",
    });
  });
});

it("keeps cleanup evidence when the composed build returns its primary failure", async () => {
  const buildInput = await input();
  const evidencePath = join(buildInput.outputDir, "cleanup.json");
  const published: CleanupEvidence[][] = [];
  const writer = fileCleanupEvidenceWriter(
    evidencePath,
    join(buildInput.outputDir, "release.json"),
    async (_releaseRecord, path) => {
      published.push(JSON.parse(await readFile(path, "utf8")) as CleanupEvidence[]);
    },
  );
  const effects = new GcloudImageBuildEffects(
    async (_command, args) => {
      if (args[0] === "compute" && args[1] === "operations" && args[2] === "list")
        return { stdout: "[]", stderr: "" };
      if (args[0] === "compute" && args[2] === "describe")
        throw new Error(`${args[3]} was not found`);
      throw new Error("primary build failure");
    },
    undefined,
    undefined,
    writer,
  );

  const result = await buildNativeImage(buildInput, effects, new AbortController().signal);

  expect(result.isErr() && result.error).toMatchObject({
    stage: "prerequisites",
    message: "primary build failure",
  });
  const retained = JSON.parse(await readFile(evidencePath, "utf8")) as CleanupEvidence[];
  expect(retained).toHaveLength(4);
  expect(retained.every((entry) => entry.status === "absent")).toBe(true);
  expect(published.at(-1)).toEqual(retained);
});
