import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { SubagentWork } from "./subagent-work.ts";

it("retains admitted work through cancellation cleanup under competing completions", async () => {
  await runDst({ name: "subagent-cancel-drain", iterations: 100 }, async (sim) => {
    const work = new SubagentWork();
    const first = work.admit("one", "operation")._unsafeUnwrap();
    const second = work.admit("two", "operation")._unsafeUnwrap();
    const drained = new Set<string>();
    let cancelled = false;
    const result = await sim.runTasks([
      {
        name: "abort",
        f: async (task) => {
          await task.checkpoint("cancellation fence");
          work.cancel("operation");
          cancelled = true;
          expect(work.busy).toBe(drained.size !== 2);
          expect(work.mayWake("one", "operation")).toBe(false);
        },
      },
      ...[first, second].map((run) => ({
        name: run.childId,
        f: async (task: import("determined").SimulationTask) => {
          await task.checkpoint("tool stopped; cleanup pending");
          expect(work.busy).toBe(true);
          await task.checkpoint("cleanup and persistence complete");
          work.release(run);
          drained.add(run.childId);
          expect(work.busy).toBe(drained.size !== 2);
          if (cancelled) expect(work.mayWake(run.childId, "operation")).toBe(false);
        },
      })),
    ]);
    if (result.isErr()) throw result.error;
    expect(work.busy).toBe(false);
  });
});

it("fences duplicate/old terminal callbacks across resumed runs and operation cancellation", async () => {
  await runDst({ name: "subagent-stale-terminal", iterations: 100 }, async (sim) => {
    const work = new SubagentWork();
    const old = work.admit("child", "old")._unsafeUnwrap();
    work.cancel("old");
    work.release(old);
    const current = work.admit("child", "new")._unsafeUnwrap();
    expect(current).not.toBe(old);
    const result = await sim.runTasks([
      {
        name: "stale-terminal",
        f: async (task) => {
          await task.checkpoint("old callback delivered");
          work.release(old);
          work.cancel("old");
          expect(work.mayWake("child", "new")).toBe(true);
        },
      },
      {
        name: "current-terminal",
        f: async (task) => {
          await task.checkpoint("new execution drained");
          expect(work.busy).toBe(true);
          work.release(current);
          expect(work.busy).toBe(false);
        },
      },
    ]);
    if (result.isErr()) throw result.error;
  });
});

it("admits once before starting and never transfers active work to another operation", () => {
  const work = new SubagentWork();
  const run = work.admit("child", "op")._unsafeUnwrap();
  expect(work.admit("child", "op")._unsafeUnwrap()).toBe(run);
  expect(work.admit("child", "other").isErr()).toBe(true);
  expect(work.busy).toBe(true);
  work.release(run);
  expect(work.mayWake("child", "op")).toBe(true);
  expect(work.mayWake("child", "other")).toBe(false);
  expect(work.mayWake("unknown", "op")).toBe(false);
});
