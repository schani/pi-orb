import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { fetchIdToken, type IdTokenEndpoint, type IdTokenObservation } from "./token.ts";

class ClockTask extends NoSimulationTask {
  now = 0;
  oversleepMs = 0;
  constructor() {
    super("mint-budget-test", false);
  }
  override monotonicNow(): number {
    return this.now;
  }
  override sleep(ms: number): Promise<void> {
    this.now += ms + this.oversleepMs;
    return Promise.resolve();
  }
}

describe("identity retry budget", () => {
  it("does not start another request when a delayed wake exhausts the budget", async () => {
    const task = new ClockTask();
    task.oversleepMs = 10_000;
    const events: IdTokenObservation[] = [];
    let attempts = 0;
    const endpoint: IdTokenEndpoint = {
      mint: async () => {
        attempts++;
        return { kind: "rate_limited", retryAfterMs: 1_000 };
      },
    };
    const result = await fetchIdToken(task, endpoint, { audience: "test" }, undefined, (event) =>
      events.push(event),
    );
    expect(result.isErr() && result.error.type).toBe("rate_limited");
    expect(attempts).toBe(1);
    expect(events.at(-1)).toEqual({ event: "budget_exhausted", attempt: 1, elapsedMs: 11_000 });
  });

  it("does not sleep until a retry with no remaining request budget", async () => {
    const task = new ClockTask();
    const endpoint: IdTokenEndpoint = {
      mint: async () => ({ kind: "rate_limited", retryAfterMs: 10_000 }),
    };
    expect((await fetchIdToken(task, endpoint, { audience: "test" })).isErr()).toBe(true);
    expect(task.now).toBe(0);
  });

  it("reports timings and retry hints but excludes request, token and error text", async () => {
    const task = new ClockTask();
    const events: IdTokenObservation[] = [];
    let calls = 0;
    const endpoint: IdTokenEndpoint = {
      mint: async () => {
        task.now += 100;
        return ++calls === 1
          ? { kind: "retryable", retryAfterMs: 500, message: "SECRET_ERROR" }
          : { kind: "token", token: "SECRET_TOKEN" };
      },
    };
    const result = await fetchIdToken(
      task,
      endpoint,
      { audience: "SECRET_AUDIENCE" },
      undefined,
      (event) => events.push(event),
    );
    expect(result.isOk()).toBe(true);
    expect(events).toEqual([
      { event: "attempt", attempt: 1, elapsedMs: 0, timeoutMs: 10_000 },
      { event: "result", attempt: 1, elapsedMs: 100, outcome: "retryable", retryAfterMs: 500 },
      { event: "retry", attempt: 1, elapsedMs: 100, waitMs: 500 },
      { event: "attempt", attempt: 2, elapsedMs: 600, timeoutMs: 9_400 },
      { event: "result", attempt: 2, elapsedMs: 700, outcome: "token" },
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });
});
