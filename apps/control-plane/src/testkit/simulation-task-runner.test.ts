import { NoSimulationTask } from "determined";
import { expect, it, vi } from "vitest";
import { SimulationTaskRunner } from "./simulation-task-runner.ts";

const task = new NoSimulationTask("mailbox worker", false);

it("dispatches queued/waiting jobs on its task, rejects duplicates and recovers from failure", async () => {
  const runner = new SimulationTaskRunner();
  const stop = new AbortController();
  const seen: unknown[] = [];
  const failure = new Error("scripted worker failure");
  const failed = runner.run("lane", async (worker) => {
    seen.push(worker);
    throw failure;
  });
  await expect(runner.run("lane", async () => expect.fail("duplicate ran"))).rejects.toThrow(
    "duplicate queued",
  );
  const worker = runner.worker(task, "lane", stop.signal);
  try {
    await expect(failed).rejects.toBe(failure);
    await runner.run("lane", async (worker) => {
      seen.push(worker);
    });
    expect(seen).toEqual([task, task]);
    expect(runner.calls).toBe(3);
  } finally {
    stop.abort();
    await worker;
  }
});

it("removes idle listeners, joins in-flight work and wakes an idle worker on abort", async () => {
  const runner = new SimulationTaskRunner();
  const stop = new AbortController();
  const added = vi.spyOn(stop.signal, "addEventListener");
  const removed = vi.spyOn(stop.signal, "removeEventListener");
  const worker = runner.worker(task, "lane", stop.signal);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const job = runner.run("lane", async () => {
    enter();
    await held;
  });
  try {
    await entered;
    expect(added).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]?.[1]);
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
    const idleStop = new AbortController();
    const idle = runner.worker(task, "idle", idleStop.signal);
    idleStop.abort();
    await idle;
    expect(runner.calls).toBe(1);
  } finally {
    release();
    stop.abort();
    await worker;
  }
});
