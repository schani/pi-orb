import type { SimulationTask } from "determined";
import type { Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  type BrokerClientConstants,
  type BrokerClientError,
  type BrokerEndpoint,
  type BrokerEndpointResult,
  BrokerTokenClient,
  type BrokerTokenGrant,
  type TokenRequestBody,
} from "./broker-client.ts";

const TEST_CONSTANTS: BrokerClientConstants = {
  bootRetryWindowMs: 10_000,
  retryWindowMs: 5_000,
  backoffBaseMs: 100,
  backoffCapMs: 1_000,
};

function grant(generation: number): BrokerEndpointResult {
  return {
    kind: "grant",
    grant: {
      accessToken: `access-${generation}`,
      accountId: "acct_test",
      expiresAt: 9_999_999_999_999,
      generation,
    },
  };
}

/** Scripted endpoint: consumes one result per call; repeats the last one. */
class ScriptedEndpoint implements BrokerEndpoint {
  readonly bodies: TokenRequestBody[] = [];
  private readonly script: BrokerEndpointResult[];

  constructor(script: BrokerEndpointResult[]) {
    this.script = script;
  }

  async requestToken(task: SimulationTask, body: TokenRequestBody): Promise<BrokerEndpointResult> {
    await task.sleep(1 + task.random("endpoint latency") * 20, "endpoint latency");
    this.bodies.push(body);
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next === undefined) return { kind: "retryable", message: "script exhausted" };
    return next;
  }
}

function expectOk(
  result: Result<BrokerTokenGrant, BrokerClientError>,
  label: string,
): BrokerTokenGrant {
  expect(result.isOk(), `${label}: ${JSON.stringify(result.isErr() ? result.error : null)}`).toBe(
    true,
  );
  if (result.isErr()) throw new Error("unreachable");
  return result.value;
}

describe("broker token client (DST)", () => {
  it("fetches a token and omits staleGeneration on startup", async () => {
    await runDst({ name: "client-startup", iterations: 15 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([grant(1)]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const got = expectOk(await client.fetch(task, "startup"), "startup fetch");
            expect(got.generation).toBe(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.bodies).toEqual([{ reason: "startup" }]);
    });
  });

  it("retries 503s with backoff until the grant arrives", async () => {
    await runDst({ name: "client-retry-503", iterations: 20 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([
        { kind: "retryable", message: "busy", retryAfterMs: 200 },
        { kind: "retryable", message: "busy" },
        grant(1),
      ]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            expectOk(await client.fetch(task, "startup"), "after retries");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.bodies.length).toBe(3);
    });
  });

  it("tolerates boot-window 401s while the token hash is still uncommitted", async () => {
    await runDst({ name: "client-boot-401", iterations: 20 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([
        { kind: "unauthorized" },
        { kind: "unauthorized" },
        grant(1),
      ]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            expectOk(await client.fetch(task, "startup"), "after boot 401s");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("a persistent 401 is terminal once the window closes", async () => {
    await runDst({ name: "client-persistent-401", iterations: 15 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "unauthorized" }]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const outcome = await client.fetch(task, "startup");
            expect(outcome.isErr() && outcome.error.type).toBe("unauthorized");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("auth_required is terminal immediately", async () => {
    await runDst({ name: "client-auth-required", iterations: 15 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "auth_required" }]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const outcome = await client.fetch(task, "startup");
            expect(outcome.isErr() && outcome.error.type).toBe("auth_required");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.bodies.length).toBe(1);
    });
  });

  it("concurrent fetches share one in-flight request", async () => {
    await runDst({ name: "client-singleflight", iterations: 25 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([grant(1)]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const grants: BrokerTokenGrant[] = [];
      const result = await sim.runTasks(
        Array.from({ length: 4 }, (_, i) => ({
          name: `caller-${i}`,
          f: async (task: SimulationTask) => {
            grants.push(expectOk(await client.fetch(task, "startup"), `caller-${i}`));
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.bodies.length).toBe(1);
      expect(grants.length).toBe(4);
      for (const got of grants) expect(got.generation).toBe(1);
    });
  });

  it("a later expiring fetch reports the held generation", async () => {
    await runDst({ name: "client-stale-generation", iterations: 15 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([grant(1), grant(2)]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            expectOk(await client.fetch(task, "startup"), "startup");
            const second = expectOk(await client.fetch(task, "expiring"), "expiring");
            expect(second.generation).toBe(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.bodies[1]).toEqual({ reason: "expiring", staleGeneration: 1 });
    });
  });

  it("persistent 503s exhaust the window into a typed unavailable", async () => {
    await runDst({ name: "client-window-exhausted", iterations: 15 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "retryable", message: "down" }]);
      const client = new BrokerTokenClient(endpoint, TEST_CONSTANTS);
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const outcome = await client.fetch(task, "expiring");
            expect(outcome.isErr() && outcome.error.type).toBe("unavailable");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
