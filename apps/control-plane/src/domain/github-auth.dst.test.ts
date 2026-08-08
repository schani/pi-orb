import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { FakeAuthGate } from "../testkit/auth.ts";
import {
  FakePointerStore,
  FakeSecretStore,
  FakeUpstream,
  makeCredential,
} from "../testkit/broker.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { FakeGithubOAuthClient } from "../testkit/github.ts";
import { runDst } from "../testkit/sim.ts";
import { CompositeAuthGate, SerializedAuthGate } from "./auth-gates.ts";
import { GITHUB_PROVIDER, getToken } from "./broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./constants.ts";
import { GithubAuthGate } from "./github-auth.ts";
import type { AuthResolution, BrokerDeps } from "./ports.ts";

const CODEX = "openai-codex";

interface GithubHarness {
  readonly pointers: FakePointerStore;
  readonly secrets: FakeSecretStore;
  readonly client: FakeGithubOAuthClient;
  readonly gate: GithubAuthGate;
  readonly deps: BrokerDeps;
}

function makeGithubHarness(clientOptions?: {
  intervalMs?: number;
  expiresInMs?: number;
}): GithubHarness {
  const pointers = new FakePointerStore();
  const secrets = new FakeSecretStore();
  const client = new FakeGithubOAuthClient(clientOptions);
  const deps: BrokerDeps = {
    pointers,
    secrets,
    upstreams: { [GITHUB_PROVIDER]: new FakeUpstream("unseeded") },
    constants: DEFAULT_BROKER_CONSTANTS,
  };
  const gate = new GithubAuthGate(deps, client);
  return { pointers, secrets, client, gate, deps };
}

/** Tick ensureAuth like the reconciler until `done` accepts a resolution. */
async function driveUntil(
  task: SimulationTask,
  gate: { ensureAuth: GithubAuthGate["ensureAuth"] },
  done: (resolution: AuthResolution) => boolean,
  options?: { tickMs?: number; maxTicks?: number },
): Promise<AuthResolution> {
  const tickMs = options?.tickMs ?? 1_000;
  const maxTicks = options?.maxTicks ?? 200;
  let last: AuthResolution | null = null;
  for (let i = 0; i < maxTicks; i++) {
    const resolution = await gate.ensureAuth(task);
    expect(resolution.isOk(), "ensureAuth must not hard-error").toBe(true);
    if (resolution.isOk()) {
      last = resolution.value;
      if (done(last)) return last;
    }
    await task.sleep(tickMs, "reconcile tick");
  }
  throw new Error(`driveUntil exhausted; last resolution: ${JSON.stringify(last)}`);
}

describe("GitHub auth gate (DST)", () => {
  it("serializes concurrent callers onto one global device flow", async () => {
    await runDst({ name: "github-login-concurrent-single-flow", iterations: 30 }, async (sim) => {
      const harness = makeGithubHarness();
      const gate = new SerializedAuthGate(harness.gate);
      const result = await sim.runTasks([
        { name: "orb-a", f: async (task) => await gate.ensureAuth(task) },
        { name: "orb-b", f: async (task) => await gate.ensureAuth(task) },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (result.isErr()) return;
      for (const resolution of result.value) {
        expect(resolution.isOk()).toBe(true);
        if (resolution.isOk()) {
          expect(resolution.value.status).toBe("pending");
          if (resolution.value.status === "pending") {
            expect(resolution.value.challenge.userCode).toBe("CODE-1");
          }
        }
      }
      expect(harness.client.deviceCodeRequests).toBe(1);
    });
  });

  it("shares one failed-flow result with callers already waiting in the same wave", async () => {
    await runDst({ name: "github-login-concurrent-failure-wave", iterations: 30 }, async (sim) => {
      const harness = makeGithubHarness({ intervalMs: 100 });
      harness.client.pushPoll({ kind: "denied" });
      const gate = new SerializedAuthGate(harness.gate);
      let releaseCallers: () => void = () => undefined;
      const callersReady = new Promise<void>((resolve) => {
        releaseCallers = resolve;
      });
      const resolutions: AuthResolution[] = [];
      const result = await sim.runTasks([
        {
          name: "prepare-flow",
          f: async (task) => {
            const pending = await gate.ensureAuth(task);
            expect(pending.isOk() && pending.value.status).toBe("pending");
            await task.sleep(101, "device poll becomes due");
            releaseCallers();
          },
        },
        {
          name: "orb-a",
          f: async (task) => {
            await callersReady;
            const resolution = await gate.ensureAuth(task);
            expect(resolution.isOk()).toBe(true);
            if (resolution.isOk()) resolutions.push(resolution.value);
          },
        },
        {
          name: "orb-b",
          f: async (task) => {
            await callersReady;
            const resolution = await gate.ensureAuth(task);
            expect(resolution.isOk()).toBe(true);
            if (resolution.isOk()) resolutions.push(resolution.value);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(resolutions.map((resolution) => resolution.status)).toEqual(["failed", "failed"]);
      expect(harness.client.deviceCodeRequests).toBe(1);
    });
  });

  it("runs the device flow to a committed credential the broker serves", async () => {
    await runDst({ name: "github-login-happy", iterations: 25 }, async (sim) => {
      const harness = makeGithubHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            const pending = await driveUntil(
              task,
              harness.gate,
              (resolution) => resolution.status === "pending",
            );
            if (pending.status !== "pending") throw new Error("unreachable");
            expect(pending.challenge.provider).toBe("github");
            expect(pending.challenge.userCode).toBe("CODE-1");
            expect(pending.challenge.verificationUri).toBe("https://github.test/login/device");

            harness.client.authorize();
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok");

            const grant = await getToken(task, harness.deps, GITHUB_PROVIDER, {
              reason: "startup",
            });
            expect(grant.isOk(), "github token grant").toBe(true);
            if (grant.isOk()) {
              expect(grant.value.accessToken).toBe("gh-access-1");
              expect(grant.value.accountId).toBe("octocat");
            }
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      harness.pointers.assertGenerationMonotonic();
      expect(harness.client.deviceCodeRequests).toBe(1);
    });
  });

  it("never polls faster than the device-flow interval, honoring slow_down", async () => {
    await runDst({ name: "github-poll-pacing", iterations: 25 }, async (sim) => {
      const harness = makeGithubHarness({ intervalMs: 5_000 });
      harness.client.pushPoll({ kind: "pending" }, { kind: "slow_down" });
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            await driveUntil(task, harness.gate, () => harness.client.pollTimes.length >= 4, {
              tickMs: 500,
              maxTicks: 400,
            });
            harness.client.authorize();
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok", {
              tickMs: 500,
              maxTicks: 400,
            });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const times = harness.client.pollTimes;
      for (let i = 1; i < times.length; i++) {
        const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
        expect(gap, `poll gap ${i}`).toBeGreaterThanOrEqual(5_000);
      }
      // The slow_down outcome was the second poll: every later gap is wider.
      for (let i = 3; i < times.length; i++) {
        const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
        expect(gap, `post-slow_down poll gap ${i}`).toBeGreaterThanOrEqual(10_000);
      }
    });
  });

  it("reports an expired device code and starts a fresh flow", async () => {
    await runDst({ name: "github-flow-expiry", iterations: 25 }, async (sim) => {
      const harness = makeGithubHarness({ expiresInMs: 15_000 });
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            const failed = await driveUntil(
              task,
              harness.gate,
              (resolution) => resolution.status === "failed",
            );
            if (failed.status !== "failed") throw new Error("unreachable");
            expect(failed.retryable).toBe(true);
            expect(failed.message).toContain("expired");

            const fresh = await driveUntil(
              task,
              harness.gate,
              (resolution) =>
                resolution.status === "pending" && resolution.challenge.userCode === "CODE-2",
            );
            expect(fresh.status).toBe("pending");
            harness.client.authorize();
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.client.deviceCodeRequests).toBe(2);
    });
  });

  it("reports a denied authorization and allows a later retry", async () => {
    await runDst({ name: "github-denied", iterations: 25 }, async (sim) => {
      const harness = makeGithubHarness();
      harness.client.deny();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            const failed = await driveUntil(
              task,
              harness.gate,
              (resolution) => resolution.status === "failed",
            );
            if (failed.status !== "failed") throw new Error("unreachable");
            expect(failed.message).toContain("denied");
            harness.client.authorize();
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.client.deviceCodeRequests).toBe(2);
    });
  });

  it("retries the commit of an authorized credential without a second ceremony", async () => {
    await runDst({ name: "github-commit-retry", iterations: 25 }, async (sim) => {
      const harness = makeGithubHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "pending");
            harness.secrets.failWrites = true;
            harness.client.authorize();
            // The poll succeeds but the commit cannot persist: the gate must
            // hold the credential and keep failing retryably.
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "failed", {
              maxTicks: 400,
            });
            harness.secrets.failWrites = false;
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // The device code was consumed exactly once; recovery reused the
      // in-memory credential instead of restarting the ceremony.
      expect(harness.client.deviceCodeRequests).toBe(1);
      harness.pointers.assertGenerationMonotonic();
    });
  });

  it("survives transient device-code and poll failures", async () => {
    await runDst(
      {
        name: "github-transient-oauth",
        iterations: 40,
        failpointProbabilities: {
          [FAILPOINTS.githubDeviceCode]: 0.2,
          [FAILPOINTS.githubDevicePoll]: 0.2,
          [FAILPOINTS.brokerPointerRead]: 0.05,
        },
      },
      async (sim) => {
        const harness = makeGithubHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              await driveUntil(
                task,
                harness.gate,
                (resolution) => resolution.status === "pending",
                { maxTicks: 400 },
              );
              harness.client.authorize();
              await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok", {
                maxTicks: 400,
              });
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        harness.pointers.assertGenerationMonotonic();
      },
    );
  });

  it("leaves the model credential untouched while GitHub logs in", async () => {
    await runDst({ name: "github-provider-isolation", iterations: 25 }, async (sim) => {
      const harness = makeGithubHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            const codexCredential = makeCredential(task);
            const codexVersion = harness.secrets.seedSecret(CODEX, codexCredential);
            harness.pointers.seedRow({
              provider: CODEX,
              rowVersion: 1,
              generation: 7,
              secretVersion: codexVersion,
              refreshLeaseUntil: 0,
              lastRefreshAt: 0,
            });

            await driveUntil(task, harness.gate, (resolution) => resolution.status === "pending");
            harness.client.authorize();
            await driveUntil(task, harness.gate, (resolution) => resolution.status === "ok");

            const codexPointer = harness.pointers.snapshot(CODEX);
            expect(codexPointer?.generation).toBe(7);
            expect(codexPointer?.secretVersion).toBe(codexVersion);
            const githubPointer = harness.pointers.snapshot(GITHUB_PROVIDER);
            expect(githubPointer?.secretVersion).not.toBeNull();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});

describe("composite auth gate (DST)", () => {
  it("resolves gates in order and reports the first blocking challenge", async () => {
    await runDst({ name: "composite-gate-order", iterations: 25 }, async (sim) => {
      const codexGate = new FakeAuthGate({
        kind: "requires_login",
        autoCompleteAfterMs: null,
        challengeTtlMs: 900_000,
      });
      const harness = makeGithubHarness();
      const composite = new CompositeAuthGate([codexGate, harness.gate]);
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            const first = await driveUntil(
              task,
              composite,
              (resolution) => resolution.status === "pending",
            );
            if (first.status !== "pending") throw new Error("unreachable");
            expect(first.challenge.provider).toBe("openai-codex");
            // The GitHub ceremony must not have started while Codex blocks.
            expect(harness.client.deviceCodeRequests).toBe(0);

            codexGate.completeLogin();
            const second = await driveUntil(
              task,
              composite,
              (resolution) =>
                resolution.status === "pending" && resolution.challenge.provider === "github",
            );
            expect(second.status).toBe("pending");

            harness.client.authorize();
            await driveUntil(task, composite, (resolution) => resolution.status === "ok");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
