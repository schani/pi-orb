import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  fetchIdToken,
  type IdTokenEndpoint,
  type IdTokenEndpointResult,
  type IdTokenRequest,
} from "./token.ts";

/**
 * A cold ingress queues accepted requests independently of client cancellation.
 * Replies are scheduled FIFO when the server becomes ready. A timed-out request
 * still consumes the server's mint slot; abandoning HTTP does not retract it.
 */
class ColdIngress implements IdTokenEndpoint {
  readonly arrivals: number[] = [];
  readonly deadlines: number[] = [];
  private lastReplyAt = 0;
  private lastMintAt = Number.NEGATIVE_INFINITY;
  private readonly readyAt: number;
  constructor(readyAt: number) {
    this.readyAt = readyAt;
  }

  async mint(
    task: SimulationTask,
    _request: IdTokenRequest,
    timeoutMs: number,
  ): Promise<IdTokenEndpointResult> {
    const now = task.monotonicNow();
    this.arrivals.push(now);
    this.deadlines.push(timeoutMs);
    const replyAt = Math.max(now, this.readyAt, this.lastReplyAt + 1);
    this.lastReplyAt = replyAt;
    const retryAfterMs = this.lastMintAt + 2_000 - replyAt;
    const reply: IdTokenEndpointResult =
      retryAfterMs > 0
        ? { kind: "rate_limited", retryAfterMs }
        : { kind: "token", token: "test-only-token" };
    if (reply.kind === "token") this.lastMintAt = replyAt;
    const responseDelay = replyAt - now;
    await task.sleep(Math.min(timeoutMs, responseDelay), "ingress response or client deadline");
    return responseDelay >= timeoutMs
      ? { kind: "retryable", message: "client HTTP deadline" }
      : reply;
  }
}

describe("identity CLI cold-start budget (DST)", () => {
  it("reproduces why a three-second attempt cap self-throttles behind cold ingress", async () => {
    await runDst({ name: "id-token-historical-attempt-cap", iterations: 10 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const start = task.monotonicNow();
            const ingress = new ColdIngress(start + 8_500);
            const historical: IdTokenEndpoint = {
              mint: (task, request, budget) => ingress.mint(task, request, Math.min(3_000, budget)),
            };
            const minted = await fetchIdToken(task, historical, { audience: "test" });
            expect(minted.isErr() && minted.error.type).toBe("rate_limited");
            expect(ingress.arrivals.map((at) => at - start)).toEqual([0, 3_250, 6_750]);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("keeps the ten-second total bound when the server stays unavailable", async () => {
    await runDst({ name: "id-token-cold-ingress-deadline", iterations: 10 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const start = task.monotonicNow();
            const ingress = new ColdIngress(start + 20_000);
            const minted = await fetchIdToken(task, ingress, { audience: "test" });
            expect(minted.isErr() && minted.error.type).toBe("unavailable");
            expect(ingress.arrivals).toHaveLength(1);
            expect(task.monotonicNow() - start).toBe(10_000);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("retries a fast failure using only the budget remaining after work and backoff", async () => {
    await runDst({ name: "id-token-remaining-budget", iterations: 10 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const start = task.monotonicNow();
            const ingress = new ColdIngress(start + 9_000);
            const timeouts: number[] = [];
            const endpoint: IdTokenEndpoint = {
              mint: async (task, request, timeoutMs) => {
                timeouts.push(timeoutMs);
                if (timeouts.length === 1) {
                  await task.sleep(100, "fast upstream failure");
                  return { kind: "retryable", message: "upstream restarting" };
                }
                return ingress.mint(task, request, timeoutMs);
              },
            };
            expect((await fetchIdToken(task, endpoint, { audience: "test" })).isOk()).toBe(true);
            expect(timeouts).toEqual([10_000, 9_650]);
            expect(task.monotonicNow() - start).toBe(9_000);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("waits for the first queued mint rather than abandoning it and self-throttling", async () => {
    await runDst({ name: "id-token-cold-ingress", iterations: 10 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const start = task.monotonicNow();
            const ingress = new ColdIngress(start + 8_500);
            const minted = await fetchIdToken(task, ingress, { audience: "test" });
            expect(minted.isOk()).toBe(true);
            expect(ingress.arrivals).toHaveLength(1);
            expect(ingress.deadlines).toEqual([10_000]);
            expect(task.monotonicNow() - start).toBe(8_500);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
