import { docker } from "./harness.ts";

const RUNTIME_IMAGE = "pi-orb-runtime:dev";

export default async function setup(): Promise<void> {
  if (process.env["PI_ORB_E2E_BACKEND"] === "process") return;
  await docker(["build", "-f", "apps/orb-runtime/Dockerfile", "-t", RUNTIME_IMAGE, "."], 600_000);
  await docker(
    ["build", "-f", "e2e/fixtures/preview.Dockerfile", "-t", "pi-orb-preview-fixture:dev", "."],
    600_000,
  );
}
