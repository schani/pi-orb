import { existsSync, readdirSync } from "node:fs";
import { setImmediate } from "node:timers";
import { expect, it } from "vitest";
import { runDst } from "./sim.ts";

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
