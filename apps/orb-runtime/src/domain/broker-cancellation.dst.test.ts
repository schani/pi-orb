import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { type BrokerEndpointResult, BrokerTokenClient } from "./broker-client.ts";

const constants = {
  bootRetryWindowMs: 100,
  retryWindowMs: 100,
  backoffBaseMs: 10,
  backoffCapMs: 10,
};
const grant: BrokerEndpointResult = {
  kind: "grant",
  grant: { accessToken: "fixture", expiresAt: 9999999999999, generation: 1 },
};

it("the retry budget includes held endpoint I/O and clears singleflight", async () => {
  await runDst({ name: "broker-held-io-budget", iterations: 10 }, async (sim) => {
    let calls = 0;
    const client = new BrokerTokenClient(
      {
        requestToken: async (task: SimulationTask, _body, signal?: AbortSignal) => {
          calls++;
          if (calls > 1 || !signal) return grant;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          await task.checkpoint("endpoint I/O drained");
          return { kind: "cancelled" } as BrokerEndpointResult;
        },
      },
      constants,
    );
    const result = await sim.runTasks([
      {
        name: "caller",
        f: async (task) => {
          const first = await client.fetch(task, "expiring");
          expect(first.isErr() && first.error.type).toBe("unavailable");
          expect((await client.fetch(task, "expiring")).isOk()).toBe(true);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    expect(calls).toBe(2);
  });
});

it("one cancelled waiter leaves shared I/O running; the final waiter drains it", async () => {
  await runDst({ name: "broker-cancelled-waiter-ownership", iterations: 20 }, async (sim) => {
    let entered = () => {};
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active: AbortSignal | undefined;
    let calls = 0;
    let drained = false;
    const client = new BrokerTokenClient(
      {
        requestToken: async (task, _body, signal) => {
          calls++;
          if (calls > 1) return grant;
          active = signal;
          entered();
          if (!signal) return grant;
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          await task.checkpoint("shared request drained");
          drained = true;
          return { kind: "cancelled" };
        },
      },
      constants,
    );
    const result = await sim.runTasks([
      {
        name: "callers",
        f: async (task) => {
          const first = new AbortController();
          const second = new AbortController();
          const one = client.fetch(task, "expiring", first.signal);
          await entry;
          const two = client.fetch(task, "expiring", second.signal);
          first.abort();
          const firstResult = await one;
          expect(firstResult.isErr() && firstResult.error.type).toBe("cancelled");
          expect(active?.aborted).toBe(false);
          second.abort();
          const replacement = client.fetch(task, "expiring");
          const secondResult = await two;
          expect(secondResult.isErr() && secondResult.error.type).toBe("cancelled");
          expect(drained).toBe(true);
          expect((await replacement).isOk()).toBe(true);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    expect(calls).toBe(2);
  });
});

it("a response arriving after the budget cannot publish a grant even if the deadline timer is late", async () => {
  await runDst({ name: "broker-late-response-grant-fence", iterations: 30 }, async (sim) => {
    const client = new BrokerTokenClient(
      {
        requestToken: async (task) => {
          await task.sleep(1000, "response arrives after budget");
          return grant;
        },
      },
      constants,
    );
    const result = await sim.runTasks([
      {
        name: "caller",
        f: async (task) => {
          // Hold the budget timer while virtual time advances past its deadline.
          const heldDeadline = new AbortController();
          const lateTask: SimulationTask = {
            ...task,
            createDeadline: () => ({ signal: heldDeadline.signal, cancel: () => {} }),
          };
          const outcome = await client.fetch(lateTask, "expiring");
          expect(heldDeadline.signal.aborted).toBe(false);
          expect(outcome.isErr() && outcome.error.type).toBe("unavailable");
          expect(client.currentGrant()).toBeNull();
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});

it("Retry-After cannot extend the existing flight budget", async () => {
  await runDst({ name: "broker-retry-after-budget", iterations: 10 }, async (sim) => {
    const client = new BrokerTokenClient(
      { requestToken: async () => ({ kind: "retryable", message: "busy", retryAfterMs: 100000 }) },
      constants,
    );
    const result = await sim.runTasks([
      {
        name: "caller",
        f: async (task) => {
          const started = task.monotonicNow();
          const outcome = await client.fetch(task, "expiring");
          expect(outcome.isErr() && outcome.error.type).toBe("unavailable");
          expect(task.monotonicNow() - started).toBeLessThan(1000);
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
});
