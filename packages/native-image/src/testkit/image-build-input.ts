import type { ImageBuildInput } from "../orchestrator.ts";

export function imageBuildInput(overrides: Partial<ImageBuildInput> = {}): ImageBuildInput {
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
    outputDir: "/sim/native-image",
    validationRepositoryUrl: "https://github.com/example/repo",
    inputInventory: {},
    toolingInputInventory: {},
    ...overrides,
  };
}
