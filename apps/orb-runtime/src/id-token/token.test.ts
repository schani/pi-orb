import { MAX_AUDIENCE_BYTES } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import {
  CLI_ID_TOKEN_CONSTANTS,
  describeIdTokenFailure,
  EXIT_INTERNAL,
  EXIT_NOT_MINTABLE,
  EXIT_RATE_LIMITED,
  EXIT_UNAUTHORIZED,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  exitCodeFor,
  fetchIdToken,
  type IdTokenEndpoint,
  type IdTokenEndpointResult,
  type IdTokenRequest,
  parseIdTokenArgs,
} from "./token.ts";

class ScriptedEndpoint implements IdTokenEndpoint {
  readonly requests: IdTokenRequest[] = [];
  private readonly script: IdTokenEndpointResult[];

  constructor(script: IdTokenEndpointResult[]) {
    this.script = script;
  }

  async mint(task: SimulationTask, request: IdTokenRequest): Promise<IdTokenEndpointResult> {
    await task.sleep(1 + task.random("mint latency") * 20, "mint latency");
    this.requests.push(request);
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next === undefined) return { kind: "retryable", message: "script exhausted" };
    return next;
  }
}

/** An endpoint that must never be reached: validation precedes every request. */
class ForbiddenEndpoint implements IdTokenEndpoint {
  async mint(): Promise<IdTokenEndpointResult> {
    throw new Error("the endpoint must not be called for an invalid request");
  }
}

describe("id-token argument parsing", () => {
  it("accepts both flag forms and the shim's subcommand word", () => {
    for (const argv of [
      ["--audience", "urn:example:rp"],
      ["--audience=urn:example:rp"],
      ["id-token", "--audience", "urn:example:rp"],
    ]) {
      const parsed = parseIdTokenArgs(argv);
      expect(parsed.isOk(), JSON.stringify(argv)).toBe(true);
      if (parsed.isOk()) expect(parsed.value).toEqual({ audience: "urn:example:rp" });
    }
  });

  it("parses an explicit lifetime in both forms", () => {
    for (const argv of [
      ["--audience", "a", "--ttl-seconds", "120"],
      ["--ttl-seconds=120", "--audience=a"],
    ]) {
      const parsed = parseIdTokenArgs(argv);
      expect(parsed.isOk(), JSON.stringify(argv)).toBe(true);
      if (parsed.isOk()) expect(parsed.value).toEqual({ audience: "a", ttlSeconds: 120 });
    }
  });

  it("omits the lifetime entirely when unspecified, leaving the issuer default", () => {
    const parsed = parseIdTokenArgs(["--audience", "a"]);
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) expect("ttlSeconds" in parsed.value).toBe(false);
  });

  it("rejects every invalid argument shape before any request", () => {
    const cases: [string, readonly string[]][] = [
      ["--audience is required", []],
      ["--audience is required", ["--ttl-seconds", "120"]],
      ["--audience is required", ["--audience", ""]],
      ["--audience requires a value", ["--audience"]],
      ["--ttl-seconds requires a value", ["--audience", "a", "--ttl-seconds"]],
      ["--audience given twice", ["--audience", "a", "--audience", "b"]],
      ["--ttl-seconds given twice", ["--audience", "a", "--ttl-seconds=90", "--ttl-seconds=91"]],
      ["unknown argument: --nope", ["--audience", "a", "--nope"]],
      ["unknown argument: extra", ["--audience", "a", "extra"]],
      ["whole number of seconds", ["--audience", "a", "--ttl-seconds", "90.5"]],
      ["whole number of seconds", ["--audience", "a", "--ttl-seconds", "-90"]],
      ["whole number of seconds", ["--audience", "a", "--ttl-seconds", "1e3"]],
      ["--ttl-seconds must be 60..3600", ["--audience", "a", "--ttl-seconds", "10"]],
      ["--ttl-seconds must be 60..3600", ["--audience", "a", "--ttl-seconds", "3601"]],
      [
        `--audience must be at most ${MAX_AUDIENCE_BYTES} UTF-8 bytes`,
        ["--audience", "x".repeat(MAX_AUDIENCE_BYTES + 1)],
      ],
      // The cap is bytes, not characters: 256 two-byte characters exceed 512.
      [
        `--audience must be at most ${MAX_AUDIENCE_BYTES} UTF-8 bytes`,
        ["--audience", "é".repeat(MAX_AUDIENCE_BYTES / 2 + 1)],
      ],
    ];
    for (const [expected, argv] of cases) {
      const parsed = parseIdTokenArgs(argv);
      expect(parsed.isErr(), JSON.stringify(argv)).toBe(true);
      if (parsed.isErr()) {
        expect(parsed.error.type).toBe("usage");
        expect(describeIdTokenFailure(parsed.error)).toContain(expected);
        expect(describeIdTokenFailure(parsed.error)).toContain("usage: pi-orb id-token");
        expect(exitCodeFor(parsed.error)).toBe(EXIT_USAGE);
      }
    }
  });

  it("accepts the exact bounds", () => {
    for (const argv of [
      ["--audience", "a", "--ttl-seconds", "60"],
      ["--audience", "a", "--ttl-seconds", "3600"],
      ["--audience", "x".repeat(MAX_AUDIENCE_BYTES)],
    ]) {
      expect(parseIdTokenArgs(argv).isOk(), JSON.stringify(argv)).toBe(true);
    }
  });

  it("never touches the endpoint for an invalid request", async () => {
    await runDst({ name: "id-token-validation-first", iterations: 5 }, async (sim) => {
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const parsed = parseIdTokenArgs(["--audience", "a", "--ttl-seconds", "10"]);
            expect(parsed.isErr()).toBe(true);
            if (parsed.isOk()) {
              await fetchIdToken(task, new ForbiddenEndpoint(), parsed.value);
            }
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});

describe("id-token mint (DST)", () => {
  it("returns the signed token and sends exactly the caller's request", async () => {
    await runDst({ name: "id-token-mint", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "token", token: "header.body.signature" }]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const token = await fetchIdToken(task, endpoint, {
              audience: "urn:example:rp",
              ttlSeconds: 120,
            });
            expect(token.isOk()).toBe(true);
            if (token.isOk()) expect(token.value).toBe("header.body.signature");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.requests).toEqual([{ audience: "urn:example:rp", ttlSeconds: 120 }]);
    });
  });

  it("rides out the first-boot 401 window and then succeeds", async () => {
    await runDst({ name: "id-token-boot-401", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([
        { kind: "unauthorized" },
        { kind: "unauthorized" },
        { kind: "token", token: "jwt" },
      ]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const token = await fetchIdToken(task, endpoint, { audience: "a" });
            expect(token.isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(endpoint.requests.length).toBe(3);
    });
  });

  it("gives up on a persistent 401 inside the bounded window", async () => {
    await runDst({ name: "id-token-401-exhausted", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "unauthorized" }]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const before = task.monotonicNow();
            const token = await fetchIdToken(task, endpoint, { audience: "a" });
            expect(token.isErr()).toBe(true);
            if (token.isErr()) {
              expect(token.error.type).toBe("unauthorized");
              expect(exitCodeFor(token.error)).toBe(EXIT_UNAUTHORIZED);
              // Neither the bearer nor a token may appear in what the user sees.
              expect(describeIdTokenFailure(token.error)).not.toContain("Bearer");
            }
            expect(task.monotonicNow() - before).toBeLessThanOrEqual(
              CLI_ID_TOKEN_CONSTANTS.retryWindowMs + 1_000,
            );
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("waits out the per-orb mint floor honoring retry-after", async () => {
    await runDst({ name: "id-token-rate-limited", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([
        { kind: "rate_limited", retryAfterMs: 2_000 },
        { kind: "token", token: "jwt" },
      ]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const before = task.monotonicNow();
            const token = await fetchIdToken(task, endpoint, { audience: "a" });
            expect(token.isOk()).toBe(true);
            expect(task.monotonicNow() - before).toBeGreaterThanOrEqual(2_000);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("reports a still-throttled floor rather than sleeping past the window", async () => {
    await runDst({ name: "id-token-rate-limited-exhausted", iterations: 10 }, async (sim) => {
      // A retry-after longer than the CLI's whole budget: answer now.
      const endpoint = new ScriptedEndpoint([{ kind: "rate_limited", retryAfterMs: 60_000 }]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const before = task.monotonicNow();
            const token = await fetchIdToken(task, endpoint, { audience: "a" });
            expect(token.isErr()).toBe(true);
            if (token.isErr()) expect(exitCodeFor(token.error)).toBe(EXIT_RATE_LIMITED);
            expect(task.monotonicNow() - before).toBeLessThan(
              CLI_ID_TOKEN_CONSTANTS.retryWindowMs + 1_000,
            );
            expect(endpoint.requests.length).toBe(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("retries a transient issuer failure and reports it as unavailable when it persists", async () => {
    await runDst({ name: "id-token-retryable", iterations: 10 }, async (sim) => {
      const endpoint = new ScriptedEndpoint([{ kind: "retryable", message: "signer down" }]);
      const result = await sim.runTasks([
        {
          name: "cli",
          f: async (task) => {
            const before = task.monotonicNow();
            const token = await fetchIdToken(task, endpoint, { audience: "a" });
            expect(token.isErr()).toBe(true);
            if (token.isErr()) {
              expect(exitCodeFor(token.error)).toBe(EXIT_UNAVAILABLE);
              expect(describeIdTokenFailure(token.error)).toContain("signer down");
            }
            expect(endpoint.requests.length).toBeGreaterThan(1);
            expect(task.monotonicNow() - before).toBeLessThanOrEqual(
              CLI_ID_TOKEN_CONSTANTS.retryWindowMs + 1_000,
            );
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("never retries a refusal a later attempt cannot change", async () => {
    const cases: [IdTokenEndpointResult, number][] = [
      [{ kind: "not_mintable", message: "orb state stopped may not mint" }, EXIT_NOT_MINTABLE],
      [{ kind: "invalid_request", message: "audience must be 1..512 UTF-8 bytes" }, EXIT_USAGE],
      [{ kind: "internal", message: "store invariant" }, EXIT_INTERNAL],
    ];
    for (const [outcome, expectedExit] of cases) {
      await runDst({ name: `id-token-terminal-${outcome.kind}`, iterations: 5 }, async (sim) => {
        const endpoint = new ScriptedEndpoint([outcome]);
        const result = await sim.runTasks([
          {
            name: "cli",
            f: async (task) => {
              const token = await fetchIdToken(task, endpoint, { audience: "a" });
              expect(token.isErr()).toBe(true);
              if (token.isErr()) expect(exitCodeFor(token.error)).toBe(expectedExit);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(endpoint.requests.length).toBe(1);
      });
    }
  });
});
