import { expect, it } from "vitest";
import { runDst } from "../../../testkit/sim.ts";
import { CpuBudget } from "./cpu-budget.js";

it("preserves aggregate credit across concurrent consumption, refills, cancellation and reentry", async () => {
  await runDst({ name: "codemode-cpu-budget", iterations: 100 }, async (sim) => {
    let now = 0n;
    let consumed = 0n;
    const budget = new CpuBudget(
      () => now,
      () => ({}),
      () => {},
    );
    const credit = new BigInt64Array(budget.buffer, 0, 1);
    const result = await sim.runTasks(
      Array.from({ length: 3 }, (_, worker) => ({
        name: `worker-${worker}`,
        f: async (task) => {
          const lease = budget.acquire();
          for (let i = 0; i < 60; i++) {
            await task.checkpoint("before-cpu-checkpoint");
            now = BigInt(task.monotonicNow()) * 1_000_000n;
            budget.refill();
            if (Atomics.load(credit, 0) <= 0n) {
              await task.sleep(20, "parked-until-refill");
              continue;
            }
            await task.checkpoint("admitted-before-debit");
            Atomics.sub(credit, 0, 1000n);
            consumed += 1000n;
            expect(consumed).toBeLessThanOrEqual(now / 1000n + 20_000n + 3000n);
            if (task.random("cancel-at-checkpoint") < 0.02) break;
          }
          lease.release();
          await task.checkpoint("released-before-reentry");
          const again = budget.acquire();
          again.release();
        },
      })),
    );
    expect(result.isOk()).toBe(true);
    expect(budget.active).toBe(0);
    expect(Atomics.load(credit, 0)).toBeLessThanOrEqual(20_000n);
  });
});
