import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
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

it("stops before the next iteration once the signal aborts, without a failure trace", async () => {
  const name = `aborted-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  let calls = 0;
  await expect(
    runDst({ name, iterations: 3, signal: controller.signal }, async () => {
      calls++;
      controller.abort();
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
  const traces = existsSync("test-failures") ? readdirSync("test-failures") : [];
  expect(traces.filter((entry) => entry.startsWith(`${name}-`))).toEqual([]);
});

it("seeded command and scheduling entropy repeats, varies by seed, and replays", async () => {
  const sample = async (seed: number) => {
    const values: number[] = [];
    await runDst({ name: "seed-unit", seed, iterations: 1 }, async (sim) => {
      const result = await sim.runTasks(
        [0, 1].map((actor) => ({
          name: `actor ${actor}`,
          f: async (task) => {
            values.push(task.random("command"));
            await task.sleep(task.random("spacing") * 10, "spacing");
            values.push(task.random("result"));
          },
        })),
      );
      expect(result.isOk()).toBe(true);
    });
    return values;
  };
  expect(await sample(42)).toEqual(await sample(42));
  expect(await sample(42)).not.toEqual(await sample(43));
});

it("does not call a different replay error reproduction", async () => {
  const name = `different-replay-${process.pid}-${Date.now()}`;
  let calls = 0;
  try {
    await expect(
      runDst({ name, seed: 0, iterations: 1 }, async () => {
        throw new Error(++calls === 1 ? "acceptance missing: input-1" : "trace divergence");
      }),
    ).rejects.toThrow("DID NOT reproduce");
  } finally {
    for (const entry of readdirSync("test-failures")) {
      if (entry.startsWith(`${name}-`)) unlinkSync(`test-failures/${entry}`);
    }
  }
});

it("replays a seeded concurrent timer failure with identical command evidence", async () => {
  const name = `seed-replay-${process.pid}-${Date.now()}`;
  const originalReplay = process.env["DST_REPLAY"];
  const runs: number[][] = [];
  const scenario: Parameters<typeof runDst>[1] = async (sim) => {
    const values: number[] = [];
    runs.push(values);
    await sim.runTasks(
      [0, 1].map((actor) => ({
        name: `actor ${actor}`,
        f: async (task) => {
          values.push(task.random("command"));
          await task.sleep(task.random("delay") * 100, "delay");
          values.push(task.monotonicNow());
        },
      })),
    );
    throw new Error("seeded invariant: receipt missing");
  };
  try {
    delete process.env["DST_REPLAY"];
    await expect(runDst({ name, seed: 123, iterations: 1 }, scenario)).rejects.toThrow(
      "replay reproduces",
    );
    const filename = readdirSync("test-failures").find((entry) => entry.startsWith(`${name}-`));
    expect(filename).toBeDefined();
    process.env["DST_REPLAY"] = `test-failures/${filename}`;
    await expect(runDst({ name, seed: 999, iterations: 1 }, scenario)).rejects.toThrow(
      "seeded invariant: receipt missing",
    );
    expect(runs).toHaveLength(3);
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]).toEqual(runs[2]);
  } finally {
    if (originalReplay === undefined) delete process.env["DST_REPLAY"];
    else process.env["DST_REPLAY"] = originalReplay;
    for (const entry of readdirSync("test-failures"))
      if (entry.startsWith(`${name}-`)) unlinkSync(`test-failures/${entry}`);
  }
});

it("distinguishes identical replay messages from different invariant locations", async () => {
  const name = `replay-location-${process.pid}-${Date.now()}`;
  const first = () => {
    throw new Error("same message");
  };
  const second = () => {
    throw new Error("same message");
  };
  let calls = 0;
  try {
    await expect(
      runDst({ name, seed: 0, iterations: 1 }, async () => {
        if (++calls === 1) first();
        else second();
      }),
    ).rejects.toThrow("DID NOT reproduce");
  } finally {
    for (const entry of readdirSync("test-failures"))
      if (entry.startsWith(`${name}-`)) unlinkSync(`test-failures/${entry}`);
  }
});

it("keeps late timer telemetry out of application lifecycle evidence", async () => {
  const capture = new LogCapture();
  await runDst(
    {
      name: "timer-telemetry",
      seed: 42,
      iterations: 1,
      lateTimerProbability: 1,
      logCapture: capture,
    },
    async (sim) => {
      const result = await sim.runTasks(
        [1, 100, 1000].map((delay) => ({
          name: `timer ${delay}`,
          f: async (task) => {
            await task.sleep(delay, "timer");
          },
        })),
      );
      expect(result.isOk()).toBe(true);
    },
  );
  expect(capture.lines()).toEqual([]);
});
