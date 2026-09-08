import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { expect, it } from "vitest";
import { LogCapture, runDst } from "./sim.ts";

it("retains the original error and lifecycle evidence in a replay-compatible DST trace", async () => {
  const name = `failure-artifact-${process.pid}-${Date.now()}`;
  const capture = new LogCapture();
  try {
    await expect(
      runDst({ name, iterations: 1, logCapture: capture }, async () => {
        capture.log("lifecycle: orb=test from=running to=stopped");
        throw new Error("original failure");
      }),
    ).rejects.toThrow("original failure");

    const filename = readdirSync("test-failures").find((entry) => entry.startsWith(`${name}-`));
    expect(filename).toBeDefined();
    const artifact = JSON.parse(readFileSync(`test-failures/${filename}`, "utf8")) as {
      error: string;
      lifecycleLines: string[];
      records: unknown[];
    };
    expect(artifact.error).toBe("original failure");
    expect(artifact.lifecycleLines).toEqual(["lifecycle: orb=test from=running to=stopped"]);
    expect(Array.isArray(artifact.records)).toBe(true);
  } finally {
    for (const entry of readdirSync("test-failures")) {
      if (entry.startsWith(`${name}-`)) unlinkSync(`test-failures/${entry}`);
    }
  }
});
