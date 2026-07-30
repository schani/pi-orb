import type { SimulationTask } from "determined";
import type { Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  FakePointerStore,
  FakeSecretStore,
  FakeUpstream,
  makeCredential,
} from "../testkit/broker.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { runDst } from "../testkit/sim.ts";
import { commitLoginCredential, getModelToken, type ModelTokenGrant } from "./broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import type { ModelTokenError } from "./errors.ts";
import type { BrokerDeps, StoredCredential } from "./ports.ts";

const PROVIDER = "openai-codex";

interface BrokerHarness {
  readonly pointers: FakePointerStore;
  readonly secrets: FakeSecretStore;
  readonly upstream: FakeUpstream;
  readonly deps: BrokerDeps;
}

function makeBrokerHarness(): BrokerHarness {
  const pointers = new FakePointerStore();
  const secrets = new FakeSecretStore();
  const upstream = new FakeUpstream("unseeded");
  return {
    pointers,
    secrets,
    upstream,
    deps: { pointers, secrets, upstream, constants: DEFAULT_BROKER_CONSTANTS },
  };
}

/** Seeds a committed generation-1 credential the upstream accepts for refresh. */
function seedCredential(
  task: SimulationTask,
  harness: BrokerHarness,
  options?: { expiresInMs?: number },
): StoredCredential {
  const credential = makeCredential(task, options);
  const version = harness.secrets.seedSecret(PROVIDER, credential);
  harness.pointers.seedRow({
    provider: PROVIDER,
    rowVersion: 1,
    generation: 1,
    secretVersion: version,
    refreshLeaseUntil: 0,
    lastRefreshAt: 0,
  });
  harness.upstream.adoptLogin(credential);
  return credential;
}

function expectOk(
  result: Result<ModelTokenGrant, ModelTokenError>,
  label: string,
): ModelTokenGrant {
  expect(result.isOk(), `${label}: ${JSON.stringify(result.isErr() ? result.error : null)}`).toBe(
    true,
  );
  if (result.isErr()) throw new Error("unreachable");
  return result.value;
}

function errType(result: Result<ModelTokenGrant, ModelTokenError>): string | null {
  return result.isErr() ? result.error.type : null;
}

describe("credential broker (DST)", () => {
  it("serves a fresh credential without refreshing", async () => {
    await runDst({ name: "broker-serve-fresh", iterations: 15 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const credential = seedCredential(task, harness, { expiresInMs: 3_600_000 });
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, { reason: "startup" }),
              "startup grant",
            );
            expect(grant.accessToken).toBe(credential.access);
            expect(grant.generation).toBe(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(0);
    });
  });

  it("reports auth_required when no credential exists", async () => {
    await runDst({ name: "broker-auth-required", iterations: 10 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const outcome = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            expect(errType(outcome)).toBe("auth_required");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(0);
    });
  });

  it("acceptance: a refresh storm coalesces into one upstream refresh", async () => {
    await runDst({ name: "broker-storm", iterations: 40 }, async (sim) => {
      const harness = makeBrokerHarness();
      const grants: ModelTokenGrant[] = [];
      const result = await sim.runTasks([
        {
          name: "seeder",
          f: async (task) => {
            // Near expiry: under the 5-minute proactive threshold.
            seedCredential(task, harness, { expiresInMs: 2 * 60_000 });
          },
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          name: `runtime-${i}`,
          f: async (task: SimulationTask) => {
            await task.sleep(1 + task.random("stagger") * 500, "stagger");
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "expiring",
                staleGeneration: 1,
              }),
              `runtime-${i}`,
            );
            grants.push(grant);
          },
        })),
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(1);
      for (const grant of grants) {
        expect(grant.generation).toBe(2);
      }
      harness.pointers.assertGenerationMonotonic();
    });
  });

  it("a rejected current token forces a refresh even when nominally fresh", async () => {
    await runDst({ name: "broker-rejected", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: 3_600_000 });
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "rejected",
                staleGeneration: 1,
              }),
              "rejected grant",
            );
            expect(grant.generation).toBe(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(1);
    });
  });

  it("a stale rejection of an old generation serves the current token without refreshing", async () => {
    await runDst({ name: "broker-stale-rejection", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: 3_600_000 });
            const first = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "rejected",
                staleGeneration: 1,
              }),
              "first rejection",
            );
            expect(first.generation).toBe(2);
            // A second caller still holding generation 1 reports it rejected;
            // the broker already rotated and must serve generation 2 as-is.
            const second = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "rejected",
                staleGeneration: 1,
              }),
              "stale rejection",
            );
            expect(second.generation).toBe(2);
            expect(second.accessToken).toBe(first.accessToken);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(1);
    });
  });

  it("transient upstream failure while the token is valid serves the current token", async () => {
    await runDst({ name: "broker-transient-valid", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const credential = seedCredential(task, harness, { expiresInMs: 3 * 60_000 });
            harness.upstream.pushScript({ kind: "transient" }, { kind: "transient" });
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "expiring",
                staleGeneration: 1,
              }),
              "grant despite transient",
            );
            expect(grant.generation).toBe(1);
            expect(grant.accessToken).toBe(credential.access);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("an expired token with 429-then-success converges to a new credential", async () => {
    await runDst({ name: "broker-transient-expired", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: -1_000 });
            harness.upstream.pushScript({ kind: "transient" }, { kind: "transient" });
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, { reason: "startup" }),
              "grant after retries",
            );
            expect(grant.generation).toBe(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(3);
    });
  });

  it("invalid_grant clears the credential once and reports auth_required", async () => {
    await runDst({ name: "broker-invalid-grant", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: -1_000 });
            harness.upstream.revokeAll();
            const first = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            expect(errType(first)).toBe("auth_required");
            // The pointer is cleared: later requests never touch the upstream.
            const second = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            expect(errType(second)).toBe("auth_required");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(1);
      expect(harness.pointers.snapshot(PROVIDER)?.secretVersion).toBeNull();
      harness.pointers.assertGenerationMonotonic();
    });
  });

  it("loss window: a lost refresh response ends in re-login, never corruption", async () => {
    await runDst({ name: "broker-lost-response", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: 3 * 60_000 });
            // The upstream rotates, but the response never arrives.
            harness.upstream.pushScript({ kind: "apply_then_transient" });
            const early = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "expiring",
                staleGeneration: 1,
              }),
              "still-valid grant",
            );
            expect(early.generation).toBe(1);
            // Once expired, the stored refresh token is dead: forced re-login.
            await task.sleep(4 * 60_000, "wait for expiry");
            const after = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            expect(errType(after)).toBe("auth_required");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.pointers.snapshot(PROVIDER)?.secretVersion).toBeNull();
      harness.pointers.assertGenerationMonotonic();
    });
  });

  it("loss window: a failing secret write surfaces and later forces re-login", async () => {
    await runDst({ name: "broker-secret-write-loss", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: -1_000 });
            harness.secrets.failWrites = true;
            const first = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            expect(errType(first)).toBe("token_retryable");
            harness.secrets.failWrites = false;
            // The upstream rotated during the failed attempt; the stored
            // refresh token is dead. Wait out the refresh rate limit.
            await task.sleep(31_000, "past refresh rate limit");
            const second = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            expect(errType(second)).toBe("auth_required");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.pointers.snapshot(PROVIDER)?.secretVersion).toBeNull();
      harness.pointers.assertGenerationMonotonic();
    });
  });

  it("loss window: a login that cannot persist leaves the old credential intact", async () => {
    await runDst({ name: "broker-login-loss", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "login",
          f: async (task) => {
            const old = seedCredential(task, harness, { expiresInMs: 3_600_000 });
            harness.secrets.failWrites = true;
            const fresh = makeCredential(task, { expiresInMs: 3_600_000 });
            const commit = await commitLoginCredential(task, harness.deps, PROVIDER, fresh);
            expect(commit.isErr()).toBe(true);
            harness.secrets.failWrites = false;
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, { reason: "startup" }),
              "old credential grant",
            );
            expect(grant.accessToken).toBe(old.access);
            expect(grant.generation).toBe(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("a stale invalid_grant cannot clobber a newer login", async () => {
    await runDst({ name: "broker-stale-clear", iterations: 30 }, async (sim) => {
      const harness = makeBrokerHarness();
      let loginCredential: StoredCredential | null = null;
      let loginCommitted = false;
      const result = await sim.runTasks([
        {
          name: "slow-refresher",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: -1_000 });
            harness.upstream.revokeAll();
            // Causal gate: the invalid_grant lands only after the login has
            // durably committed — no timer schedule can reorder that.
            harness.upstream.pushScript({ kind: "until", ready: () => loginCommitted });
            const outcome = await getModelToken(task, harness.deps, PROVIDER, {
              reason: "startup",
            });
            // The fenced clear must fail and the newer credential be served.
            const grant = expectOk(outcome, "grant after superseded clear");
            expect(grant.accessToken).toBe(loginCredential?.access);
          },
        },
        {
          name: "login",
          f: async (task) => {
            await task.sleep(1_000, "login while refresh is gated");
            const fresh = makeCredential(task, { expiresInMs: 3_600_000 });
            harness.upstream.adoptLogin(fresh);
            loginCredential = fresh;
            const commit = await commitLoginCredential(task, harness.deps, PROVIDER, fresh);
            expect(commit.isOk(), JSON.stringify(commit)).toBe(true);
            loginCommitted = true;
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const pointer = harness.pointers.snapshot(PROVIDER);
      expect(pointer?.secretVersion).not.toBeNull();
      harness.pointers.assertGenerationMonotonic();
    });
  });

  it("an abandoned lease expires and a later request recovers", async () => {
    await runDst({ name: "broker-abandoned-lease", iterations: 20 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: -1_000 });
            // A crashed instance left a live lease behind.
            const row = harness.pointers.snapshot(PROVIDER);
            if (row === null) throw new Error("seed missing");
            harness.pointers.seedRow({
              ...row,
              rowVersion: row.rowVersion + 1,
              refreshLeaseUntil: task.wallNow() + harness.deps.constants.leaseMs,
            });
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, { reason: "startup" }),
              "grant after lease expiry",
            );
            expect(grant.generation).toBe(2);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(1);
    });
  });

  it("a live lease does not block a startup request for a still-valid token", async () => {
    await runDst({ name: "broker-lease-serve", iterations: 15 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "runtime",
          f: async (task) => {
            const credential = seedCredential(task, harness, { expiresInMs: 3 * 60_000 });
            const row = harness.pointers.snapshot(PROVIDER);
            if (row === null) throw new Error("seed missing");
            harness.pointers.seedRow({
              ...row,
              rowVersion: row.rowVersion + 1,
              refreshLeaseUntil: task.wallNow() + harness.deps.constants.leaseMs,
            });
            const grant = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, { reason: "startup" }),
              "grant under foreign lease",
            );
            expect(grant.accessToken).toBe(credential.access);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(0);
    });
  });

  it("the refresh rate limit bounds what a hostile rejected-storm can force", async () => {
    await runDst({ name: "broker-rate-limit", iterations: 15 }, async (sim) => {
      const harness = makeBrokerHarness();
      const result = await sim.runTasks([
        {
          name: "attacker",
          f: async (task) => {
            seedCredential(task, harness, { expiresInMs: 3_600_000 });
            const first = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "rejected",
                staleGeneration: 1,
              }),
              "first rejection",
            );
            expect(first.generation).toBe(2);
            // Immediately claiming the new token is also bad gets throttled.
            for (let i = 0; i < 5; i++) {
              const outcome = await getModelToken(task, harness.deps, PROVIDER, {
                reason: "rejected",
                staleGeneration: 2,
              });
              expect(errType(outcome)).toBe("token_retryable");
            }
            expect(harness.upstream.calls).toBe(1);
            await task.sleep(31_000, "past rate limit");
            const later = expectOk(
              await getModelToken(task, harness.deps, PROVIDER, {
                reason: "rejected",
                staleGeneration: 2,
              }),
              "post-window rejection",
            );
            expect(later.generation).toBe(3);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.upstream.calls).toBe(2);
    });
  });

  it("a storm under store failpoints keeps generations monotonic and settles", async () => {
    await runDst(
      {
        name: "broker-failpoint-storm",
        iterations: 40,
        failpointProbabilities: {
          [FAILPOINTS.brokerPointerRead]: 0.1,
          [FAILPOINTS.brokerPointerWriteBefore]: 0.1,
          [FAILPOINTS.brokerPointerWriteAfter]: 0.1,
          [FAILPOINTS.brokerSecretRead]: 0.05,
          [FAILPOINTS.brokerSecretWrite]: 0.05,
        },
      },
      async (sim) => {
        const harness = makeBrokerHarness();
        const outcomes: (string | null)[] = [];
        const result = await sim.runTasks([
          {
            name: "seeder",
            f: async (task) => {
              seedCredential(task, harness, { expiresInMs: 60_000 });
            },
          },
          ...Array.from({ length: 6 }, (_, i) => ({
            name: `runtime-${i}`,
            f: async (task: SimulationTask) => {
              await task.sleep(1 + task.random("stagger") * 2_000, "stagger");
              const outcome = await getModelToken(task, harness.deps, PROVIDER, {
                reason: i % 2 === 0 ? "expiring" : "startup",
                staleGeneration: 1,
              });
              outcomes.push(outcome.isOk() ? null : outcome.error.type);
            },
          })),
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        harness.pointers.assertGenerationMonotonic();
        // Every caller settled with a grant or a typed retryable error; an
        // auth_required here would mean a failpoint corrupted the credential.
        for (const outcome of outcomes) {
          expect(outcome === null || outcome === "token_retryable").toBe(true);
        }
      },
    );
  });
});
