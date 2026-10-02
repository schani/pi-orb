import { err, ok, type Result } from "neverthrow";
import { afterEach, expect, it, vi } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { DetailLoader } from "./detail-loader.ts";

afterEach(() => vi.useRealTimers());

it("DST: open running detail polls once per second without overlapping; close and navigation fence late responses", async () => {
  vi.useFakeTimers();
  await runDst({ name: "lazy-detail-owner", iterations: 30 }, async (sim) => {
    const pending: Array<(result: Result<string, string>) => void> = [];
    const seen: string[] = [];
    let active = false;
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const loader = new DetailLoader<string>({
      read: () => new Promise((resolve) => pending.push(resolve)),
      publish: (result) => {
        expect(active).toBe(true);
        if (result.isOk()) seen.push(result.value);
      },
      intervalMs: 1000,
    });
    const result = await sim.runTasks([
      {
        name: "responses",
        f: async (task) => {
          await ready;
          await task.checkpoint("first response");
          const first = pending.shift();
          expect(first).toBeDefined();
          first?.(ok("old"));
          await Promise.resolve();
          await task.checkpoint("after navigation");
          const second = pending.shift();
          if (second !== undefined) second(ok("stale"));
          await Promise.resolve();
        },
      },
      {
        name: "owner",
        f: async (task) => {
          active = true;
          loader.open("a", true);
          opened();
          await task.checkpoint("close/reopen");
          active = false;
          loader.close();
          active = true;
          loader.open("a", true);
          await task.checkpoint("navigate");
          active = false;
          loader.close();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("one in-flight read, retry after error, disconnect stops refresh and commit fences running response", async () => {
  vi.useFakeTimers();
  const pending: Array<(result: Result<string, string>) => void> = [];
  const read = vi.fn(() => new Promise<Result<string, string>>((resolve) => pending.push(resolve)));
  const publish = vi.fn();
  const loader = new DetailLoader<string>({ read, publish, intervalMs: 1000 });
  loader.open("live", true);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
  pending.shift()?.(err("unavailable"));
  await Promise.resolve();
  expect(publish).toHaveBeenCalledWith(err("unavailable"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(1);
  loader.retry();
  expect(read).toHaveBeenCalledTimes(2);
  loader.open("committed", false);
  expect(read).toHaveBeenCalledTimes(3);
  pending.shift()?.(ok("late live"));
  pending.shift()?.(ok("final"));
  await Promise.resolve();
  expect(publish).toHaveBeenLastCalledWith(ok("final"));
  expect(publish).not.toHaveBeenCalledWith(ok("late live"));
  loader.connected(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(3);
  loader.close();
});

it("terminal live snapshot stops polling", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => ok({ state: "completed" }));
  const loader = new DetailLoader({
    read,
    publish: () => {},
    shouldContinue: (detail) => detail.state === "running",
  });
  loader.open("live", true);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).toHaveBeenCalledTimes(1);
  loader.close();
});

it("coalesces pending reads across disclosure remounts sharing an active-view pool", async () => {
  const pending = new Map<string, Promise<Result<string, string>>>();
  let resolve!: (value: Result<string, string>) => void;
  const read = vi.fn(
    () =>
      new Promise<Result<string, string>>((done) => {
        resolve = done;
      }),
  );
  const previous = vi.fn();
  const current = vi.fn();
  const first = new DetailLoader({ read, publish: previous, pending });
  first.open("same", true);
  first.close();
  const second = new DetailLoader({ read, publish: current, pending });
  second.open("same", true);
  expect(read).toHaveBeenCalledTimes(1);
  resolve(ok("latest"));
  await Promise.resolve();
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledWith(ok("latest"));
  second.close();
});

it("coalesces an unfinished read across close/reopen and disconnect/reconnect without accepting the old owner", async () => {
  vi.useFakeTimers();
  let resolve!: (result: Result<string, string>) => void;
  const read = vi.fn(
    () =>
      new Promise<Result<string, string>>((done) => {
        resolve = done;
      }),
  );
  const publish = vi.fn();
  const loader = new DetailLoader<string>({ read, publish });
  loader.open("same", true);
  loader.close();
  loader.open("same", true);
  loader.connected(false);
  loader.connected(true);
  expect(read).toHaveBeenCalledTimes(1);
  resolve(ok("current"));
  await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(ok("current"));
  loader.close();
});
