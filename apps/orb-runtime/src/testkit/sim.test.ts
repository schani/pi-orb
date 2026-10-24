import { existsSync, readdirSync, readFileSync } from "node:fs";
import { setImmediate } from "node:timers";
import { afterEach, expect, it, vi } from "vitest";
import { withDstArtifacts } from "../../../../testkit/dst-artifacts.ts";
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

afterEach(() => vi.unstubAllEnvs());

it.each(["same", "message", "origin", "success"] as const)(
  "verifies %s replay failure identity and preserves both diagnostics",
  async (mode) =>
    withDstArtifacts(async (directory) => {
      vi.stubEnv("DST_REPLAY", "");
      const name = `runtime-replay-${mode}-${process.pid}-${Date.now()}`;
      let calls = 0;
      const fail = (message: string) => {
        throw new Error(message);
      };
      const otherOrigin = () => {
        throw new Error("receipt missing");
      };
      await expect(
        runDst({ name, iterations: 1 }, async (sim) => {
          calls++;
          const result = await sim.runTasks([
            {
              name: "receipt",
              f: async (task) => {
                await task.sleep(3, "receipt boundary");
                if (calls === 1 || mode === "same") fail("receipt missing");
                else if (mode === "message") fail("trace divergence");
                else if (mode === "origin") otherOrigin();
              },
            },
          ]);
          if (result.isErr()) throw result.error;
        }),
      ).rejects.toThrow(mode === "same" ? "replay reproduces" : "DID NOT reproduce");
      expect(calls).toBe(2);
      const files = readdirSync(directory).filter((entry) => entry.startsWith(`${name}-`));
      expect(files).toHaveLength(1);
      const artifact = JSON.parse(readFileSync(`${directory}/${files[0]}`, "utf8"));
      expect(artifact.error).toBe("receipt missing");
      expect(artifact.stack).toContain("sim.test.ts");
      expect(artifact.failureIdentity).toContain("receipt missing");
      expect(artifact.replay.reproduced).toBe(mode === "same");
      if (mode === "success") {
        expect(artifact.replay.error).toBeUndefined();
      } else {
        expect(artifact.replay.error).toBe(
          mode === "message" ? "trace divergence" : "receipt missing",
        );
        expect(artifact.replay.stack).toContain("sim.test.ts");
        if (mode === "same") expect(artifact.replay.failureIdentity).toBe(artifact.failureIdentity);
        else expect(artifact.replay.failureIdentity).not.toBe(artifact.failureIdentity);
      }
    }),
);
