import assert from "node:assert/strict";
import { docker } from "./harness.ts";

const RUNTIME_IMAGE = "pi-orb-runtime:dev";

export default async function setup(): Promise<void> {
  if (process.env["PI_ORB_E2E_BACKEND"] === "process") return;
  const expectedImageId = process.env["PI_ORB_E2E_RUNTIME_IMAGE_ID"];
  if (expectedImageId !== undefined) {
    // Vitest setup assertions fail the suite before any unverified image runs.
    assert.match(expectedImageId, /^sha256:[a-f0-9]{64}$/, "Invalid PI_ORB_E2E_RUNTIME_IMAGE_ID");
    const actualImageId = await docker(["image", "inspect", "--format", "{{.Id}}", RUNTIME_IMAGE]);
    assert.equal(actualImageId, expectedImageId, "E2E runtime image identity mismatch");
    console.info(`E2E runtime image verified: ${actualImageId}`);
    return;
  }
  await docker(["build", "-f", "apps/orb-runtime/Dockerfile", "-t", RUNTIME_IMAGE, "."], 600_000);
}
