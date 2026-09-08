import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  buildNativeImage,
  type CapturedImage,
  type ImageBuildEffects,
  type ImageBuildError,
  type ImageBuildInput,
  type ImageBuildManifest,
  type ImageBuildStage,
  validateImageBuildInput,
} from "./orchestrator.ts";

const input = (operationId = "owner-a"): ImageBuildInput => ({
  project: "project-a",
  zone: "us-central1-a",
  baseImage: "projects/debian-cloud/global/images/debian-12-20260902",
  version: "v20260905-a",
  subnetwork: "projects/project-a/regions/us-central1/subnetworks/orbs",
  builderServiceAccount: "image-builder@project-a.iam.gserviceaccount.com",
  validationServiceAccount: "orb-vm@project-a.iam.gserviceaccount.com",
  sourceCommit: "a".repeat(40),
  sourceDirty: false,
  sourceArchiveSha256: "b".repeat(64),
  operationId,
  outputDir: ".context/test",
  validationRepositoryUrl: "https://github.com/example/repo.git",
  inputInventory: { "infra/native-vm/install.sh": "deadbeef" },
  toolingInputInventory: { "packages/native-image/src/cli.ts": "cafe" },
});

class FakeEffects implements ImageBuildEffects {
  readonly actions: string[] = [];
  manifest?: ImageBuildManifest;
  failure?: ImageBuildError;
  failAt?: string;
  abortAt?: string;
  failManifest = false;
  retryOnceAt?: string;
  private retried = false;
  readonly controller = new AbortController();

  now(): string {
    return "2026-09-05T00:00:00.000Z";
  }
  run(stage: ImageBuildStage, action: string): ResultAsync<void, ImageBuildError> {
    const key = `${stage}:${action}`;
    this.actions.push(key);
    if (this.abortAt === key) this.controller.abort();
    if (this.retryOnceAt === key && !this.retried) {
      this.retried = true;
      return errAsync({ type: "image_build_failed", stage, message: "not ready", retryable: true });
    }
    return this.failAt === key
      ? errAsync({ type: "image_build_failed", stage, message: "injected" })
      : okAsync(undefined);
  }
  capture(): ResultAsync<CapturedImage, ImageBuildError> {
    this.actions.push("capture:create-image");
    return this.failAt === "capture:create-image"
      ? errAsync({ type: "image_build_failed", stage: "capture", message: "injected" })
      : okAsync({
          resource: "projects/project-a/global/images/image-a",
          id: "1234",
          name: "image-a",
        });
  }
  readPackageInventory(): ResultAsync<string, ImageBuildError> {
    return okAsync("curl\t1.0\n");
  }
  resolveBaseImageId(): ResultAsync<string, ImageBuildError> {
    return okAsync("9876");
  }
  verifyBuilderBaseImage(): ResultAsync<void, ImageBuildError> {
    this.actions.push("builder:verify-base-image");
    return okAsync(undefined);
  }
  wait(): ResultAsync<void, ImageBuildError> {
    return okAsync(undefined);
  }
  writeManifest(
    _input: ImageBuildInput,
    manifest: ImageBuildManifest,
  ): ResultAsync<void, ImageBuildError> {
    this.actions.push("manifest:accepted");
    if (this.failManifest)
      return errAsync({ type: "image_build_failed", stage: "manifest", message: "injected" });
    this.manifest = manifest;
    return okAsync(undefined);
  }
  writeFailure(
    _input: ImageBuildInput,
    failure: ImageBuildError,
  ): ResultAsync<void, ImageBuildError> {
    this.failure = failure;
    return okAsync(undefined);
  }
}

describe("native image build orchestration", () => {
  it("rejects moving base-image references and invalid versions before effects", () => {
    expect(validateImageBuildInput({ ...input(), baseImage: "debian-12" }).isErr()).toBe(true);
    expect(validateImageBuildInput({ ...input(), version: "Latest" }).isErr()).toBe(true);
    expect(
      validateImageBuildInput({
        ...input(),
        baseImage: "projects/debian-cloud/global/images/family/debian-12",
      }).isErr(),
    ).toBe(true);
  });

  it("accepts only after boot validation and records exact identities", async () => {
    const effects = new FakeEffects();
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isOk()).toBe(true);
    expect(effects.actions.indexOf("validate:probe")).toBeLessThan(
      effects.actions.indexOf("manifest:accepted"),
    );
    expect(effects.manifest).toMatchObject({
      status: "accepted",
      validation: true,
      baseImageId: "9876",
      imageId: "1234",
      imageResource: "projects/project-a/global/images/image-a",
    });
    expect(effects.actions.slice(-4)).toEqual([
      "cleanup:delete-validator",
      "cleanup:delete-builder",
      "cleanup:delete-data",
      "manifest:accepted",
    ]);
  });

  it("removes a rejected candidate and never writes an accepted manifest", async () => {
    const effects = new FakeEffects();
    effects.failAt = "validate:probe";
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isErr()).toBe(true);
    expect(effects.manifest).toBeUndefined();
    expect(effects.actions.slice(-4)).toEqual([
      "cleanup:delete-validator",
      "cleanup:delete-builder",
      "cleanup:delete-data",
      "cleanup:delete-image",
    ]);
    expect(effects.failure).toMatchObject({ stage: "validate" });
  });

  it("attempts candidate cleanup when capture has an ambiguous failure", async () => {
    const effects = new FakeEffects();
    effects.failAt = "capture:create-image";
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isErr()).toBe(true);
    expect(effects.actions).toContain("cleanup:delete-image");
    expect(effects.manifest).toBeUndefined();
  });

  it("cleans up with a fresh signal after cancellation", async () => {
    const effects = new FakeEffects();
    effects.abortAt = "install:run";
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isErr()).toBe(true);
    expect(effects.actions.slice(-3)).toEqual([
      "cleanup:delete-validator",
      "cleanup:delete-builder",
      "cleanup:delete-data",
    ]);
  });

  it.each([
    "prerequisites:check",
    "builder:create",
    "builder:ready",
    "install:upload",
    "install:run",
    "install:complete",
    "seal:seal",
    "capture:stop-builder",
    "validate:create",
    "validate:ready",
    "validate:probe",
    "validate:cloud-log",
  ])("never accepts after cancellation at %s", async (action) => {
    const effects = new FakeEffects();
    effects.abortAt = action;
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isErr()).toBe(true);
    expect(effects.manifest).toBeUndefined();
    if (effects.actions.includes("capture:create-image"))
      expect(effects.actions).toContain("cleanup:delete-image");
  });

  it("does not accept when temporary cleanup fails", async () => {
    const effects = new FakeEffects();
    effects.failAt = "cleanup:delete-validator";
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isErr()).toBe(true);
    expect(effects.manifest).toBeUndefined();
    expect(effects.actions).toContain("cleanup:delete-image");
  });

  it("removes the candidate when writing the manifest fails", async () => {
    const effects = new FakeEffects();
    effects.failManifest = true;
    const result = await buildNativeImage(input(), effects, effects.controller.signal);
    expect(result.isErr()).toBe(true);
    expect(effects.manifest).toBeUndefined();
    expect(effects.actions.at(-1)).toBe("cleanup:delete-image");
  });

  it("reports one waiting edge across repeated poll attempts", async () => {
    const effects = new FakeEffects();
    effects.retryOnceAt = "install:complete";
    const events: string[] = [];
    const result = await buildNativeImage(input(), effects, effects.controller.signal, (event) =>
      events.push(`${event.stage}:${event.action}:${event.status}`),
    );
    expect(result.isOk()).toBe(true);
    expect(events.filter((event) => event === "install:complete:started")).toHaveLength(1);
    expect(events.filter((event) => event === "install:complete:waiting")).toHaveLength(1);
    expect(events.filter((event) => event === "install:complete:succeeded")).toHaveLength(1);
  });
});
