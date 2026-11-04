import { setTimeout as nodeTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

it("leaves imported Node timers real by default", () => {
  const originalTimeout = nodeTimeout;
  const originalSleep = sleep;
  vi.useFakeTimers();
  expect(nodeTimeout).toBe(originalTimeout);
  expect(sleep).toBe(originalSleep);
});

it("advances opted-in Node timers and promise timers on the same fake clock", async () => {
  vi.useFakeTimers({ fakeNodeBuiltins: true });
  const fired = vi.fn();
  const timer = nodeTimeout(fired, 20);
  const pending = sleep(10, "ready");
  try {
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("ready");
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(fired).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.runOnlyPendingTimersAsync();
    clearTimeout(timer);
    await pending;
  }
});
