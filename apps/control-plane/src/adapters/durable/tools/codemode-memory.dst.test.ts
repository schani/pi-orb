import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { runDst } from "../../../testkit/sim.ts";
import { CodeModeMemory, MEMORY_SAMPLE_INTERVAL_MS } from "./codemode-memory.ts";

const MiB = 1024 * 1024;

it("samples exactly the live workers across concurrent starts, failures and idle gaps", async () => {
  await runDst({ name: "codemode-memory", iterations: 100 }, async (sim) => {
    const lines: { workers: number; worker_sum_mib: number }[] = [];
    let tick: (() => void) | undefined;
    const memory = new CodeModeMemory(
      (line) => lines.push(JSON.parse(line)),
      () => process.memoryUsage(),
      (callback) => {
        expect(tick).toBeUndefined();
        tick = callback;
        return {};
      },
      () => {
        tick = undefined;
      },
    );
    const live = new Map<number, number>();
    let done = 0;
    const workers = 4;
    const result = await sim.runTasks([
      ...Array.from({ length: workers }, (_, worker) => ({
        name: `invocation-${worker}`,
        f: async (task: SimulationTask) => {
          for (let run = 0; run < 3; run++) {
            await task.sleep(Math.floor(task.random("idle-gap") * 25_000), "idle-gap");
            const lease = memory.acquire(`orb-${worker}`);
            const stats = new Float64Array(lease.workerData.memoryStats);
            for (let step = 0; step < 5; step++) {
              stats[0] = (worker + 1) * (step + 1) * MiB;
              stats[1] = Math.max(stats[1] ?? 0, stats[0]);
              live.set(worker, stats[0]);
              await task.sleep(Math.floor(task.random("work") * 6_000), "work");
              if (task.random("fail") < 0.1) break;
            }
            live.delete(worker);
            lease.release();
            expect(lease.peakBytes()).toBeGreaterThanOrEqual(stats[0] ?? 0);
          }
          done++;
        },
      })),
      {
        name: "sampler",
        f: async (task) => {
          while (done < workers || tick) {
            await task.sleep(MEMORY_SAMPLE_INTERVAL_MS, "sample-interval");
            const before = lines.length;
            tick?.();
            if (live.size === 0) {
              expect(lines.length).toBe(before);
              expect(tick).toBeUndefined();
            } else {
              expect(lines.at(-1)).toMatchObject({
                workers: live.size,
                worker_sum_mib: [...live.values()].reduce((a, b) => a + b, 0) / MiB,
              });
            }
          }
        },
      },
    ]);
    expect(result.isOk()).toBe(true);
    expect(memory.active).toBe(0);
    expect(tick).toBeUndefined();
  });
});
