import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { SimulationTaskRunner } from "./simulation-task-runner.ts";

const task = new NoSimulationTask("mailbox worker", false);

describe("simulation task mailbox", () => {
  it("dispatches queued and waiting jobs on the worker task and counts calls", async () => {
    const runner = new SimulationTaskRunner();
    const stop = new AbortController();
    const seen: unknown[] = [];
    const queued = runner.run("lane", async (worker) => {
      seen.push(worker);
    });
    const worker = runner.worker(task, "lane", stop.signal);
    try {
      await queued;
      await runner.run("lane", async (worker) => {
        seen.push(worker);
      });
      expect(seen).toEqual([task, task]);
      expect(runner.calls).toBe(2);
    } finally {
      stop.abort();
      await worker;
    }
  });

  it("joins an in-flight job on shutdown and removes idle abort listeners", async () => {
    const runner = new SimulationTaskRunner();
    const stop = new AbortController();
    const originalAdd = stop.signal.addEventListener.bind(stop.signal);
    const originalRemove = stop.signal.removeEventListener.bind(stop.signal);
    let listeners = 0;
    stop.signal.addEventListener = (...args) => {
      listeners++;
      return originalAdd(...args);
    };
    stop.signal.removeEventListener = (...args) => {
      listeners--;
      return originalRemove(...args);
    };
    const worker = runner.worker(task, "lane", stop.signal);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const job = runner.run("lane", async () => {
      entered();
      await held;
    });
    try {
      await started;
      expect(listeners).toBe(0);
      let finished = false;
      void worker.then(() => {
        finished = true;
      });
      stop.abort();
      await Promise.resolve();
      expect(finished).toBe(false);
      release();
      await job;
      await worker;
      expect(finished).toBe(true);
    } finally {
      release();
      stop.abort();
      await worker;
    }
  });

  it("wakes an idle worker on abort", async () => {
    const runner = new SimulationTaskRunner();
    const stop = new AbortController();
    const worker = runner.worker(task, "idle", stop.signal);
    stop.abort();
    await worker;
    expect(runner.calls).toBe(0);
  });

  it("rejects a failed job without killing the worker or replacing queued work", async () => {
    const runner = new SimulationTaskRunner();
    const stop = new AbortController();
    const failure = new Error("scripted worker failure");
    const failed = runner.run("lane", async () => {
      throw failure;
    });
    const duplicate = runner.run("lane", async () => {
      expect.fail("duplicate ran");
    });
    await expect(duplicate).rejects.toThrow("duplicate queued");
    const worker = runner.worker(task, "lane", stop.signal);
    try {
      await expect(failed).rejects.toBe(failure);
      let recovered = false;
      await runner.run("lane", async () => {
        recovered = true;
      });
      expect(recovered).toBe(true);
      expect(runner.calls).toBe(3);
    } finally {
      stop.abort();
      await worker;
    }
  });
});
