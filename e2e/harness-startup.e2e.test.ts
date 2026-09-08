import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { waitForOwnedControlPlane } from "./harness.ts";

describe("startControlPlane", () => {
  it("rejects an exited child before probing a possibly foreign server", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(1)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

    await expect(
      waitForOwnedControlPlane(child, logs, "http://127.0.0.1:1", 1_000),
    ).rejects.toThrow("exited before listening");
  }, 10_000);
});
