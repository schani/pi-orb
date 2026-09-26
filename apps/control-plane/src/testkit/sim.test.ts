import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { setImmediate } from "node:timers";
import { expect, it } from "vitest";
import { LogCapture, runDst } from "./sim.ts";

it("yields a host turn between completed DST iterations", async () => {
  const order: string[] = [];
  let hostTurn: Promise<void> | undefined;
  try {
    await runDst({ name: "host-turn", iterations: 2 }, async () => {
      order.push("scenario");
      if (hostTurn === undefined) {
        hostTurn = new Promise<void>((resolve) => {
          setImmediate(() => {
            order.push("host turn");
            resolve();
          });
        });
      }
    });
    await hostTurn;
    expect(order).toEqual(["scenario", "host turn", "scenario"]);
  } finally {
    await hostTurn;
  }
});

it("retains the original error and lifecycle evidence in a replay-compatible DST trace", async () => {
  const name = `failure-artifact-${process.pid}-${Date.now()}`;
  const capture = new LogCapture();
  const originalReplay = process.env["DST_REPLAY"];
  let calls = 0;
  const scenario = async () => {
    calls++;
    capture.log("lifecycle: orb=test from=running to=stopped");
    throw new Error("original failure");
  };
  try {
    delete process.env["DST_REPLAY"];
    await expect(runDst({ name, iterations: 1, logCapture: capture }, scenario)).rejects.toThrow(
      "original failure",
    );
    expect(calls).toBe(2);

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

    process.env["DST_REPLAY"] = `test-failures/${filename}`;
    await expect(runDst({ name, iterations: 5, logCapture: capture }, scenario)).rejects.toThrow(
      "original failure",
    );
    expect(calls).toBe(3);
    expect(capture.lines()).toEqual(artifact.lifecycleLines);
    expect(JSON.parse(readFileSync(`test-failures/${filename}`, "utf8"))).toEqual(artifact);
  } finally {
    if (originalReplay === undefined) delete process.env["DST_REPLAY"];
    else process.env["DST_REPLAY"] = originalReplay;
    for (const entry of readdirSync("test-failures")) {
      if (entry.startsWith(`${name}-`)) unlinkSync(`test-failures/${entry}`);
    }
  }
});
