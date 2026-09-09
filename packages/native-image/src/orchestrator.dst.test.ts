import type { SimulationTask } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../../../apps/control-plane/src/testkit/sim.ts";
import {
  buildNativeImage,
  type CapturedImage,
  type ImageBuildEffects,
  type ImageBuildError,
  type ImageBuildInput,
  type ImageBuildManifest,
  type ImageBuildStage,
} from "./orchestrator.ts";

const makeInput = (owner: string): ImageBuildInput => ({
  project: "p",
  zone: "z",
  baseImage: "projects/base/global/images/pinned",
  version: `v-${owner}`,
  subnetwork: "subnet",
  builderServiceAccount: "builder@p",
  validationServiceAccount: "orb@p",
  sourceCommit: "a".repeat(40),
  sourceDirty: false,
  sourceArchiveSha256: "b".repeat(64),
  operationId: owner,
  outputDir: ".context/test",
  inputInventory: { install: "hash" },
  toolingInputInventory: { builder: "hash" },
  validationRepositoryUrl: "https://github.com/example/repo.git",
});

interface SharedState {
  resources: Map<string, string>;
  accepted: string[];
  deleted: string[];
  baseImageId?: string;
  replaceBaseOnCreate?: boolean;
}

class SimEffects implements ImageBuildEffects {
  private readonly task: SimulationTask;
  private readonly shared: SharedState;
  private readonly failOwner: string | undefined;
  private readonly injectFailpoints: boolean;
  private readonly cancellation: { action: string; controller: AbortController } | undefined;
  constructor(
    task: SimulationTask,
    shared: SharedState,
    failOwner?: string,
    injectFailpoints = false,
    cancellation?: { action: string; controller: AbortController },
  ) {
    this.task = task;
    this.shared = shared;
    this.failOwner = failOwner;
    this.injectFailpoints = injectFailpoints;
    this.cancellation = cancellation;
  }
  now(): string {
    return "2026-09-05T00:00:00.000Z";
  }
  run(
    stage: ImageBuildStage,
    action: string,
    input: ImageBuildInput,
  ): ResultAsync<void, ImageBuildError> {
    return ResultAsync.fromPromise(
      (async () => {
        await this.task.checkpoint(input.operationId, stage, action);
        if (stage === "prerequisites" && action === "check")
          this.shared.resources.set(`${input.operationId}:ssh-key`, input.operationId);
        if (this.injectFailpoints && stage !== "cleanup")
          await this.task.failpoint("native-image-stage-failure", stage, action);
        if (this.cancellation?.action === `${stage}:${action}`)
          this.cancellation.controller.abort();
        if (action === "create")
          this.shared.resources.set(`${input.operationId}:${stage}`, input.operationId);
        if (stage === "capture" && action === "create-workspace-disk")
          this.shared.resources.set(`${input.operationId}:workspace-disk`, input.operationId);
        if (stage === "builder" && action === "create" && this.shared.replaceBaseOnCreate)
          this.shared.baseImageId = "replacement-base-id";
        if (stage === "cleanup") {
          const kind = action.replace("delete-", "");
          const key =
            kind === "image" ? `${input.operationId}:image` : `${input.operationId}:${kind}`;
          if (this.shared.resources.get(key) === input.operationId) {
            this.shared.resources.delete(key);
            this.shared.deleted.push(key);
          }
        }
        if (this.failOwner === input.operationId && stage === "validate" && action === "probe")
          throw new Error("injected validation failure");
      })(),
      (cause): ImageBuildError => ({ type: "image_build_failed", stage, message: String(cause) }),
    );
  }
  capture(
    input: ImageBuildInput,
    kind: "runtime" | "workspace",
    signal: AbortSignal,
  ): ResultAsync<CapturedImage, ImageBuildError> {
    const resourceKind = kind === "runtime" ? "image" : "workspace-image";
    return ResultAsync.fromPromise(
      (async () => {
        await this.task.checkpoint(input.operationId, "capture", `create-${kind}-image`);
        this.shared.resources.set(`${input.operationId}:${resourceKind}`, input.operationId);
        if (this.injectFailpoints) await this.task.failpoint("native-image-capture-failure", kind);
        if (this.cancellation?.action === `capture:create-${kind}-image`)
          this.cancellation.controller.abort();
        if (signal.aborted) throw new Error("cancelled");
        return {
          resource: `projects/p/global/images/${input.version}-${kind}`,
          id: kind === "runtime" ? `1${input.operationId.length}` : `2${input.operationId.length}`,
          name: `${input.version}-${kind}`,
        };
      })(),
      (cause): ImageBuildError => ({
        type: signal.aborted ? "cancelled" : "image_build_failed",
        stage: "capture",
        message: String(cause),
      }),
    );
  }
  resolveBaseImageId(): ResultAsync<string, ImageBuildError> {
    return okAsync(this.shared.baseImageId ?? "base-id");
  }
  verifyBuilderBaseImage(
    _input: ImageBuildInput,
    expectedBaseImageId: string,
  ): ResultAsync<void, ImageBuildError> {
    return (this.shared.baseImageId ?? "base-id") === expectedBaseImageId
      ? okAsync(undefined)
      : errAsync({
          type: "image_build_failed",
          stage: "builder",
          message: "builder base-image identity changed",
        });
  }
  verifyValidationWorkspaceImage(): ResultAsync<void, ImageBuildError> {
    return okAsync(undefined);
  }
  readPackageInventory(): ResultAsync<string, ImageBuildError> {
    return okAsync("inventory");
  }
  wait(): ResultAsync<void, ImageBuildError> {
    return ResultAsync.fromSafePromise(this.task.checkpoint("poll-wait"));
  }
  writeManifest(
    input: ImageBuildInput,
    _manifest: ImageBuildManifest,
  ): ResultAsync<void, ImageBuildError> {
    this.shared.accepted.push(input.operationId);
    return okAsync(undefined);
  }
  writeFailure(): ResultAsync<void, ImageBuildError> {
    return okAsync(undefined);
  }
}

describe("native image orchestration (DST)", () => {
  it("keeps concurrent ownership isolated and rejects a failed generation", async () => {
    await runDst({ name: "native-image-concurrent-ownership", iterations: 30 }, async (sim) => {
      const shared = {
        resources: new Map<string, string>(),
        accepted: [] as string[],
        deleted: [] as string[],
      };
      const result = await sim.runTasks([
        {
          name: "good-build",
          f: (task) =>
            buildNativeImage(
              makeInput("good"),
              new SimEffects(task, shared, "bad"),
              new AbortController().signal,
            ),
        },
        {
          name: "bad-build",
          f: (task) =>
            buildNativeImage(
              makeInput("bad"),
              new SimEffects(task, shared, "bad"),
              new AbortController().signal,
            ),
        },
      ]);
      if (result.isErr()) throw result.error;
      expect(result.value[0]?.isOk()).toBe(true);
      expect(result.value[1]?.isErr()).toBe(true);
      expect(shared.accepted).toEqual(["good"]);
      expect(shared.resources.get("good:image")).toBe("good");
      expect(shared.resources.get("good:workspace-image")).toBe("good");
      expect(shared.resources.has("bad:image")).toBe(false);
      expect(shared.resources.has("bad:workspace-image")).toBe(false);
      expect(shared.resources.has("bad:workspace-disk")).toBe(false);
      expect(shared.deleted).not.toContain("good:image");
    });
  });

  it("never accepts a partial build under injected stage failures", async () => {
    await runDst(
      {
        name: "native-image-partial-failures",
        iterations: 50,
        // Capture failure occurs after the simulated API may have created the image.
        // Cleanup must therefore treat its response as ambiguous.
        failpointProbabilities: {
          "native-image-stage-failure": 0.2,
          "native-image-capture-failure": 0.2,
        },
      },
      async (sim) => {
        const shared = {
          resources: new Map<string, string>(),
          accepted: [] as string[],
          deleted: [] as string[],
        };
        const result = await sim.runTasks([
          {
            name: "build",
            f: (task) =>
              buildNativeImage(
                makeInput("faulted"),
                new SimEffects(task, shared, undefined, true),
                new AbortController().signal,
              ),
          },
        ]);
        if (result.isErr()) throw result.error;
        const build = result.value[0];
        if (build?.isOk()) {
          expect(shared.accepted).toEqual(["faulted"]);
          expect(shared.resources.get("faulted:image")).toBe("faulted");
          expect(shared.resources.get("faulted:workspace-image")).toBe("faulted");
        } else {
          expect(shared.accepted).toEqual([]);
          expect(shared.resources.has("faulted:image")).toBe(false);
          expect(shared.resources.has("faulted:workspace-image")).toBe(false);
          expect(shared.resources.has("faulted:workspace-disk")).toBe(false);
        }
      },
    );
  });

  it.each([
    "builder:create",
    "install:run",
    "capture:create-workspace-image",
    "capture:create-runtime-image",
    "validate:create",
    "validate:cloud-log",
  ])("cancels and cleans up from %s under deterministic scheduling", async (action) => {
    await runDst({ name: `native-image-cancel-${action}`, iterations: 20 }, async (sim) => {
      const shared = {
        resources: new Map<string, string>(),
        accepted: [] as string[],
        deleted: [] as string[],
      };
      const controller = new AbortController();
      const result = await sim.runTasks([
        {
          name: "build",
          f: (task) =>
            buildNativeImage(
              makeInput("cancelled"),
              new SimEffects(task, shared, undefined, false, { action, controller }),
              controller.signal,
            ),
        },
      ]);
      if (result.isErr()) throw result.error;
      expect(result.value[0]?.isErr()).toBe(true);
      expect(shared.accepted).toEqual([]);
      expect(shared.resources.has("cancelled:image")).toBe(false);
      expect(shared.resources.has("cancelled:workspace-image")).toBe(false);
      expect(shared.resources.has("cancelled:workspace-disk")).toBe(false);
    });
  });

  it("rejects a base image replaced between resolution and builder creation", async () => {
    await runDst({ name: "native-image-base-replacement", iterations: 20 }, async (sim) => {
      const shared: SharedState = {
        resources: new Map(),
        accepted: [],
        deleted: [],
        baseImageId: "initial-base-id",
        replaceBaseOnCreate: true,
      };
      const result = await sim.runTasks([
        {
          name: "build",
          f: (task) =>
            buildNativeImage(
              makeInput("base-race"),
              new SimEffects(task, shared),
              new AbortController().signal,
            ),
        },
      ]);
      if (result.isErr()) throw result.error;
      expect(result.value[0]?.isErr()).toBe(true);
      expect(shared.accepted).toEqual([]);
    });
  });
});
