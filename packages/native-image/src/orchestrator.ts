import { err, ok, type Result, type ResultAsync } from "neverthrow";

export type ImageBuildStage =
  | "prerequisites"
  | "builder"
  | "install"
  | "seal"
  | "capture"
  | "validate"
  | "manifest"
  | "cleanup";

export interface ImageBuildError {
  readonly type: "image_build_failed" | "cancelled";
  readonly stage: ImageBuildStage;
  readonly message: string;
  readonly retryable?: true;
}

export interface ImageBuildProgress {
  readonly stage: ImageBuildStage;
  readonly action: string;
  readonly status: "started" | "waiting" | "succeeded" | "failed";
}

export interface ImageBuildInput {
  readonly project: string;
  readonly zone: string;
  readonly baseImage: string;
  readonly version: string;
  readonly subnetwork: string;
  readonly builderServiceAccount: string;
  readonly validationServiceAccount: string;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceArchiveSha256: string;
  readonly operationId: string;
  readonly outputDir: string;
  readonly validationRepositoryUrl: string;
  readonly inputInventory: Readonly<Record<string, string>>;
  readonly toolingInputInventory: Readonly<Record<string, string>>;
}

export interface CapturedImage {
  readonly resource: string;
  readonly id: string;
  readonly name: string;
}

export interface ImageBuildManifest {
  readonly schemaVersion: 1;
  readonly status: "accepted";
  readonly operationId: string;
  readonly version: string;
  readonly project: string;
  readonly zone: string;
  readonly sourceCommit: string;
  readonly sourceDirty: boolean;
  readonly sourceArchiveSha256: string;
  readonly baseImageResource: string;
  readonly baseImageId: string;
  readonly imageResource: string;
  readonly imageId: string;
  readonly workspaceImageResource: string;
  readonly workspaceImageId: string;
  readonly validation: true;
  readonly inputInventory: Readonly<Record<string, string>>;
  readonly toolingInputInventory: Readonly<Record<string, string>>;
  readonly packageInventory: string;
  readonly startedAt: string;
  readonly acceptedAt: string;
}

export interface ImageBuildEffects {
  run(
    stage: ImageBuildStage,
    action: string,
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError>;
  capture(
    input: ImageBuildInput,
    kind: "runtime" | "workspace",
    signal: AbortSignal,
  ): ResultAsync<CapturedImage, ImageBuildError>;
  readPackageInventory(
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<string, ImageBuildError>;
  resolveBaseImageId(
    input: ImageBuildInput,
    signal: AbortSignal,
  ): ResultAsync<string, ImageBuildError>;
  verifyBuilderBaseImage(
    input: ImageBuildInput,
    expectedBaseImageId: string,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError>;
  verifyValidationWorkspaceImage(
    input: ImageBuildInput,
    expectedWorkspaceImageId: string,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError>;
  wait(
    input: ImageBuildInput,
    stage: ImageBuildStage,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError>;
  writeManifest(
    input: ImageBuildInput,
    manifest: ImageBuildManifest,
    signal: AbortSignal,
  ): ResultAsync<void, ImageBuildError>;
  writeFailure(
    input: ImageBuildInput,
    failure: ImageBuildError,
  ): ResultAsync<void, ImageBuildError>;
  now(): string;
}

const cancelled = (stage: ImageBuildStage): ImageBuildError => ({
  type: "cancelled",
  stage,
  message: "image build cancelled",
});

function checkCancellation(
  signal: AbortSignal,
  stage: ImageBuildStage,
): Result<void, ImageBuildError> {
  return signal.aborted ? err(cancelled(stage)) : ok(undefined);
}

export function validateImageBuildInput(input: ImageBuildInput): Result<void, ImageBuildError> {
  const missing = [
    ["project", input.project],
    ["zone", input.zone],
    ["base-image", input.baseImage],
    ["version", input.version],
    ["subnet", input.subnetwork],
    ["builder-service-account", input.builderServiceAccount],
    ["validation-service-account", input.validationServiceAccount],
    ["validation-repository-url", input.validationRepositoryUrl],
  ].find((entry) => entry[1]?.length === 0);
  if (missing !== undefined) {
    return err({
      type: "image_build_failed",
      stage: "prerequisites",
      message: `missing --${missing[0]}`,
    });
  }
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.version)) {
    return err({
      type: "image_build_failed",
      stage: "prerequisites",
      message: "version must be a lowercase GCE resource-name segment",
    });
  }
  if (!/^projects\/[^/]+\/global\/images\/[^/]+$/.test(input.baseImage)) {
    return err({
      type: "image_build_failed",
      stage: "prerequisites",
      message: "base image must be an exact projects/.../global/images/... resource",
    });
  }
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit)) {
    return err({
      type: "image_build_failed",
      stage: "prerequisites",
      message: "source commit must be a full Git SHA",
    });
  }
  return ok(undefined);
}

export async function buildNativeImage(
  input: ImageBuildInput,
  effects: ImageBuildEffects,
  signal: AbortSignal,
  progress: (event: ImageBuildProgress) => void = () => undefined,
): Promise<Result<ImageBuildManifest, ImageBuildError>> {
  const startedAt = effects.now();
  let runtimeCaptureAttempted = false;
  let workspaceCaptureAttempted = false;
  let primaryFailure: ImageBuildError | undefined;
  let manifest: ImageBuildManifest | undefined;
  const startedActions = new Set<string>();

  const tracked = async <T>(
    stage: ImageBuildStage,
    action: string,
    effect: () => PromiseLike<Result<T, ImageBuildError>>,
  ): Promise<T | undefined> => {
    progress({ stage, action, status: "started" });
    const result = await effect();
    if (result.isErr()) {
      primaryFailure = result.error;
      return undefined;
    }
    progress({ stage, action, status: "succeeded" });
    return result.value;
  };

  const step = async (stage: ImageBuildStage, action: string): Promise<boolean> => {
    const key = `${stage}:${action}`;
    if (!startedActions.has(key)) {
      startedActions.add(key);
      progress({ stage, action, status: "started" });
    }
    const cancellation = checkCancellation(signal, stage);
    if (cancellation.isErr()) {
      primaryFailure = cancellation.error;
      return false;
    }
    const result = await effects.run(stage, action, input, signal);
    if (result.isErr()) {
      primaryFailure = result.error;
      return false;
    }
    progress({ stage, action, status: "succeeded" });
    return true;
  };

  const poll = async (
    stage: ImageBuildStage,
    action: string,
    attempts: number,
  ): Promise<boolean> => {
    let waitingReported = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await step(stage, action)) return true;
      if (primaryFailure?.retryable !== true || attempt === attempts) {
        progress({ stage, action, status: "failed" });
        return false;
      }
      if (!waitingReported) {
        progress({ stage, action, status: "waiting" });
        waitingReported = true;
      }
      primaryFailure = undefined;
      const waited = await effects.wait(input, stage, signal);
      if (waited.isErr()) {
        primaryFailure = waited.error;
        return false;
      }
    }
    return false;
  };

  const valid = validateImageBuildInput(input);
  if (valid.isErr()) primaryFailure = valid.error;
  if (primaryFailure === undefined && !(await step("prerequisites", "check")))
    primaryFailure ??= cancelled("prerequisites");
  let baseImageId = "";
  if (primaryFailure === undefined) {
    baseImageId =
      (await tracked("prerequisites", "resolve-base-image", () =>
        effects.resolveBaseImageId(input, signal),
      )) ?? "";
  }
  if (primaryFailure === undefined && !(await step("builder", "create")))
    primaryFailure ??= cancelled("builder");
  if (primaryFailure === undefined) {
    await tracked("builder", "verify-base-image", () =>
      effects.verifyBuilderBaseImage(input, baseImageId, signal),
    );
  }
  if (primaryFailure === undefined && !(await poll("builder", "ready", 60)))
    primaryFailure ??= cancelled("builder");
  if (primaryFailure === undefined && !(await step("install", "upload")))
    primaryFailure ??= cancelled("install");
  if (primaryFailure === undefined && !(await step("install", "run")))
    primaryFailure ??= cancelled("install");
  if (primaryFailure === undefined && !(await poll("install", "complete", 240)))
    primaryFailure ??= cancelled("install");

  let packageInventory = "";
  if (primaryFailure === undefined) {
    packageInventory =
      (await tracked("install", "read-inventory", () =>
        effects.readPackageInventory(input, signal),
      )) ?? "";
  }
  if (primaryFailure === undefined && !(await step("capture", "create-workspace-disk")))
    primaryFailure ??= cancelled("capture");
  if (primaryFailure === undefined && !(await step("capture", "attach-workspace-disk")))
    primaryFailure ??= cancelled("capture");
  if (primaryFailure === undefined && !(await step("capture", "format-workspace-disk")))
    primaryFailure ??= cancelled("capture");
  if (primaryFailure === undefined && !(await step("capture", "detach-workspace-disk")))
    primaryFailure ??= cancelled("capture");
  let workspaceImage: CapturedImage | undefined;
  if (primaryFailure === undefined) {
    workspaceCaptureAttempted = true;
    workspaceImage = await tracked("capture", "create-workspace-image", () =>
      effects.capture(input, "workspace", signal),
    );
  }
  if (primaryFailure === undefined && !(await step("seal", "seal")))
    primaryFailure ??= cancelled("seal");
  if (primaryFailure === undefined && !(await step("capture", "stop-builder")))
    primaryFailure ??= cancelled("capture");
  if (primaryFailure === undefined) {
    runtimeCaptureAttempted = true;
    const image = await tracked("capture", "create-image", () =>
      effects.capture(input, "runtime", signal),
    );
    if (image !== undefined) {
      manifest = {
        schemaVersion: 1,
        status: "accepted",
        operationId: input.operationId,
        version: input.version,
        project: input.project,
        zone: input.zone,
        sourceCommit: input.sourceCommit,
        sourceDirty: input.sourceDirty,
        sourceArchiveSha256: input.sourceArchiveSha256,
        baseImageResource: input.baseImage,
        baseImageId,
        imageResource: image.resource,
        imageId: image.id,
        workspaceImageResource: (workspaceImage as CapturedImage).resource,
        workspaceImageId: (workspaceImage as CapturedImage).id,
        validation: true,
        inputInventory: input.inputInventory,
        toolingInputInventory: input.toolingInputInventory,
        packageInventory,
        startedAt,
        acceptedAt: "",
      };
    }
  }
  if (primaryFailure === undefined && !(await step("validate", "create")))
    primaryFailure ??= cancelled("validate");
  if (primaryFailure === undefined && workspaceImage !== undefined) {
    await tracked("validate", "verify-workspace-image", () =>
      effects.verifyValidationWorkspaceImage(input, workspaceImage.id, signal),
    );
  }
  if (primaryFailure === undefined && !(await poll("validate", "ready", 60)))
    primaryFailure ??= cancelled("validate");
  if (primaryFailure === undefined && !(await poll("validate", "probe", 60)))
    primaryFailure ??= cancelled("validate");
  if (primaryFailure === undefined && !(await poll("validate", "cloud-log", 60)))
    primaryFailure ??= cancelled("validate");
  if (primaryFailure === undefined && signal.aborted) primaryFailure = cancelled("validate");

  if (primaryFailure !== undefined)
    await effects.run("cleanup", "collect-evidence", input, new AbortController().signal);
  const cleanupActions = [
    "delete-validator",
    "delete-builder",
    "delete-data",
    "delete-workspace-disk",
    "delete-ssh-key",
    ...(primaryFailure && runtimeCaptureAttempted ? ["delete-image"] : []),
    ...(primaryFailure && workspaceCaptureAttempted ? ["delete-workspace-image"] : []),
  ];
  for (const action of cleanupActions) {
    progress({ stage: "cleanup", action, status: "started" });
    const result = await effects.run("cleanup", action, input, new AbortController().signal);
    if (result.isErr() && primaryFailure === undefined) primaryFailure = result.error;
    progress({ stage: "cleanup", action, status: result.isOk() ? "succeeded" : "failed" });
  }
  if (
    primaryFailure !== undefined &&
    runtimeCaptureAttempted &&
    !cleanupActions.includes("delete-image")
  ) {
    progress({ stage: "cleanup", action: "delete-image", status: "started" });
    await effects.run("cleanup", "delete-image", input, new AbortController().signal);
  }
  if (
    primaryFailure !== undefined &&
    workspaceCaptureAttempted &&
    !cleanupActions.includes("delete-workspace-image")
  ) {
    progress({ stage: "cleanup", action: "delete-workspace-image", status: "started" });
    await effects.run("cleanup", "delete-workspace-image", input, new AbortController().signal);
  }

  if (primaryFailure === undefined && manifest !== undefined) {
    progress({ stage: "manifest", action: "write-accepted", status: "started" });
    manifest = { ...manifest, acceptedAt: effects.now() };
    const written = await effects.writeManifest(input, manifest, signal);
    if (written.isErr()) {
      primaryFailure = written.error;
      await effects.run("cleanup", "delete-image", input, new AbortController().signal);
      await effects.run("cleanup", "delete-workspace-image", input, new AbortController().signal);
    } else progress({ stage: "manifest", action: "write-accepted", status: "succeeded" });
  }

  if (primaryFailure !== undefined) {
    await effects.writeFailure(input, primaryFailure);
    return err(primaryFailure);
  }
  return ok(manifest as ImageBuildManifest);
}
