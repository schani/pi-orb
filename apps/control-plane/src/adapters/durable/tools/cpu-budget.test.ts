import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { expect, it, vi } from "vitest";
import { CpuBudget, refillCpuBudget } from "./cpu-budget.js";
import { createCpuCheckpoint } from "./cpu-checkpoint.js";

it("caps idle credit, retains overshoot debt, and only credits elapsed time", () => {
  let now = 0n;
  let timer: (() => void) | undefined;
  const budget = new CpuBudget(
    () => now,
    (callback) => {
      timer = callback;
      return {};
    },
    () => {
      timer = undefined;
    },
  );
  const first = budget.acquire();
  const second = budget.acquire();
  expect(first.workerData.cpuBudget).toBe(second.workerData.cpuBudget);
  const credit = new BigInt64Array(budget.buffer, 0, 1);
  Atomics.sub(credit, 0, 70_000n);
  now = 20_000_000n;
  timer?.();
  expect(Atomics.load(credit, 0)).toBe(-30_000n);
  timer?.();
  expect(Atomics.load(credit, 0)).toBe(-30_000n);
  first.release();
  first.release();
  expect(budget.active).toBe(1);
  second.release();
  expect(timer).toBeUndefined();
  const immediate = budget.acquire();
  expect(Atomics.load(credit, 0)).toBe(-30_000n);
  immediate.release();
  now += 10_000_000_000n;
  const later = budget.acquire();
  expect(Atomics.load(credit, 0)).toBe(20_000n);
  later.release();
  expect(budget.active).toBe(0);
});

it("parks without losing VM state, charges startup and wait CPU, and observes cancellation", () => {
  const budget = new CpuBudget();
  const lease = budget.acquire();
  const interrupt = new SharedArrayBuffer(4);
  let cpu = 30_000;
  let now = 0n;
  let waits = 0;
  const checkpoint = createCpuCheckpoint(
    { ...lease.workerData, interrupt },
    {
      cpu: () => cpu,
      now: () => now,
      wait: (epoch, _index, generation) => {
        expect(Atomics.load(epoch, 0)).toBe(generation);
        waits++;
        now += 20_000_000n;
        cpu += 10;
        refillCpuBudget(budget.buffer, 20_000);
        return "ok";
      },
    },
  );
  expect(checkpoint()).toBe(false);
  expect(waits).toBe(1);
  expect(lease.snapshot()).toEqual({
    budgetCores: 1,
    cpuMs: 30.01,
    throttledMs: 20,
    checkpoints: 1,
  });
  Atomics.store(new Int32Array(interrupt), 0, 1);
  cpu += 100_000;
  expect(checkpoint()).toBe(true);
  expect(waits).toBe(1);
  expect(lease.snapshot().cpuMs).toBe(130.01);
  lease.release();
});

const workerUrl = new URL("./bounded-worker.js", import.meta.url);

it("observes a cancellation during a wait without cancelling another execution", () => {
  const budget = new CpuBudget();
  const cancelled = budget.acquire();
  const survivor = budget.acquire();
  const interrupt = new SharedArrayBuffer(4);
  const checkpoint = createCpuCheckpoint(
    { ...cancelled.workerData, interrupt },
    {
      cpu: () => 30_000,
      now: () => 0n,
      wait: () => {
        Atomics.store(new Int32Array(interrupt), 0, 1);
        return "timed-out";
      },
    },
  );
  expect(checkpoint()).toBe(true);
  cancelled.release();
  refillCpuBudget(budget.buffer, 20_000);
  const resume = createCpuCheckpoint(
    { ...survivor.workerData, interrupt: new SharedArrayBuffer(4) },
    {
      cpu: () => 0,
      now: () => 0n,
      wait: () => {
        throw new Error("Surviving worker should have credit");
      },
    },
  );
  expect(resume()).toBe(false);
  survivor.release();
});

it("runs simultaneous real VMs with the same budget and preserves callbacks, jobs and stores", async () => {
  const budget = new CpuBudget();
  const leases = [budget.acquire(), budget.acquire()];
  const sandboxes = leases.map(
    (lease) =>
      new CodemodeSandbox({
        workerUrl,
        workerData: lease.workerData,
        tools: [{ name: "echo", execute: (args) => args }],
      }),
  );
  try {
    const results = await Promise.all(
      sandboxes.map((sandbox) =>
        sandbox.execute(
          'let sum=0; for(let i=0;i<500000;i++) sum=(sum+i)|0; await Promise.resolve(); text(await tools.echo({sum})); store("sum",sum);',
        ),
      ),
    );
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.output).toEqual([{ type: "text", text: '{"sum":445698416}' }]);
      if (result.ok) expect(result.storeWrites.set).toEqual({ sum: 445698416 });
    }
    for (const lease of leases) {
      expect(lease.snapshot().cpuMs).toBeGreaterThan(0);
      expect(lease.snapshot().checkpoints).toBeGreaterThan(0);
    }
  } finally {
    await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
    for (const lease of leases) lease.release();
  }
  expect(budget.active).toBe(0);
});

it.each(["abort", "timeout", "close"] as const)(
  "terminates a parked worker on %s",
  async (mode) => {
    const budget = new CpuBudget();
    const lease = budget.acquire();
    // Force parking until cancellation; no time-dependent CPU threshold is needed.
    Atomics.store(new BigInt64Array(budget.buffer, 0, 1), 0, -1_000_000_000n);
    const abort = new AbortController();
    const sandbox = new CodemodeSandbox({ workerUrl, workerData: lease.workerData });
    try {
      if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const running = sandbox.execute('store("lost", true); for (;;) {}', {
        signal: abort.signal,
        timeoutMs: 30_000,
      });
      // Shared stats are the explicit checkpoint handshake, not a startup sleep.
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (lease.snapshot().checkpoints === 0) return;
          clearInterval(poll);
          resolve();
        }, 10);
        void running.then(() => {
          clearInterval(poll);
          reject(new Error("Worker ended before the parking handshake"));
        });
      });
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else if (mode === "abort") abort.abort();
      else await sandbox.close();
      const result = await running;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe(mode === "timeout" ? "timeout" : "aborted");
      expect(result).not.toHaveProperty("storeWrites");
    } finally {
      vi.useRealTimers();
      await sandbox.close();
      lease.release();
    }
    const next = budget.acquire();
    const credit = Atomics.load(new BigInt64Array(budget.buffer, 0, 1), 0);
    expect(credit).toBeLessThan(0n);
    next.release();
    expect(budget.active).toBe(0);
  },
);
