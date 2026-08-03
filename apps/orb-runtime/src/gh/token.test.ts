import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import type {
  BrokerEndpoint,
  BrokerEndpointResult,
  TokenRequestBody,
} from "../domain/broker-client.ts";
import { runDst } from "../testkit/sim.ts";
import {
  credentialOutput,
  describeTokenFailure,
  fetchGithubToken,
  parseCredentialRequest,
  shouldServeCredential,
} from "./token.ts";

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

describe("git credential request parsing", () => {
  it("parses key=value lines and ignores garbage", () => {
    const attrs = parseCredentialRequest("protocol=https\nhost=github.com\nnonsense\n\n");
    expect(attrs).toEqual({ protocol: "https", host: "github.com" });
  });

  it("keeps the first occurrence of a repeated key", () => {
    const attrs = parseCredentialRequest("host=github.com\nhost=evil.example\n");
    expect(attrs["host"]).toBe("github.com");
  });

  it("serves only https to github.com", () => {
    expect(shouldServeCredential({ protocol: "https", host: "github.com" })).toBe(true);
    expect(shouldServeCredential({ protocol: "http", host: "github.com" })).toBe(false);
    expect(shouldServeCredential({ protocol: "https", host: "gitlab.com" })).toBe(false);
    expect(shouldServeCredential({ protocol: "https", host: "github.com.evil.example" })).toBe(
      false,
    );
    expect(shouldServeCredential({})).toBe(false);
  });

  it("emits the x-access-token credential shape", () => {
    expect(credentialOutput("tok-1")).toBe("username=x-access-token\npassword=tok-1\n");
  });
});

describe("github token fetch (DST)", () => {
  it("returns the granted access token", async () => {
    await runDst({ name: "gh-token-grant", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([
        {
          kind: "grant",
          grant: { accessToken: "gh-tok", expiresAt: 9_999_999_999_999, generation: 1 },
        },
      ]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const token = await fetchGithubToken(task, endpoint);
            expect(token.isOk()).toBe(true);
            if (token.isOk()) expect(token.value).toBe("gh-tok");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("maps auth_required to a connect-GitHub message", async () => {
    await runDst({ name: "gh-token-auth-required", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "auth_required" }]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const token = await fetchGithubToken(task, endpoint);
            expect(token.isErr()).toBe(true);
            if (token.isErr()) expect(token.error).toContain("device login");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("gives up on persistent failures within the bounded window", async () => {
    await runDst({ name: "gh-token-unavailable", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "retryable", message: "down" }]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const before = task.monotonicNow();
            const token = await fetchGithubToken(task, endpoint);
            expect(token.isErr()).toBe(true);
            // Bounded: a CLI invocation must not hang anywhere near the
            // broker client's default 30–60s windows.
            expect(task.monotonicNow() - before).toBeLessThanOrEqual(15_000);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});

describe("failure messages", () => {
  it("names each terminal outcome", () => {
    expect(describeTokenFailure({ type: "auth_required" })).toContain("device login");
    expect(describeTokenFailure({ type: "unauthorized" })).toContain("orb token");
    expect(describeTokenFailure({ type: "unavailable", message: "down" })).toContain("down");
    expect(describeTokenFailure({ type: "fatal", message: "bug" })).toContain("bug");
  });
});
