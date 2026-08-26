import type { OrbState } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { Result } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  type MintHarness,
  makeMintHarness,
  makeOrbRow,
  makeProjectRow,
  seedOrbWithBearer,
  seedRunningOrb,
  TEST_ISSUER_URL,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { decodeFakeIdToken } from "../testkit/workload-identity.ts";
import { fakeTokenHash } from "../testkit/world.ts";
import type { MintError } from "./errors.ts";
import { requestOrbArchive, requestOrbDeletion, requestOrbStop } from "./lifecycle.ts";
import { LIFECYCLE_LOG_PREFIX } from "./log.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import { mintIdToken } from "./workload-identity.ts";

const ORB = "orb-a";
const AUDIENCE = "urn:example:service";

type MintOutcome = Result<{ token: string }, MintError>;

/** One attempt, with the wall time at which it entered the mint path. */
interface Attempt {
  readonly startedAt: number;
  readonly outcome: MintOutcome;
}

function mint(
  task: SimulationTask,
  harness: MintHarness,
  tokenHash: string,
  request?: { audience?: string; ttlSeconds?: number },
): PromiseLike<MintOutcome> {
  return mintIdToken(task, harness.mintDeps, {
    tokenHash,
    audience: request?.audience ?? AUDIENCE,
    ...(request?.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
  });
}

function errorType(outcome: MintOutcome): string | null {
  return outcome.isErr() ? outcome.error.type : null;
}

function tokenOf(outcome: MintOutcome, label: string): string {
  expect(
    outcome.isOk(),
    `${label}: ${JSON.stringify(outcome.isErr() ? outcome.error : null)}`,
  ).toBe(true);
  if (outcome.isErr()) throw new Error("unreachable");
  return outcome.value.token;
}

/**
 * The operator's whole record of one denial (docs/workload-identity.md): the
 * orb, its incarnation, and the typed code — never the audience, never a
 * token.
 */
function deniedLine(code: string, incarnation = 0): string {
  return `${LIFECYCLE_LOG_PREFIX} orb=${ORB} identity-mint-denied incarnation=${incarnation} code=${code}`;
}

/** Those lines as the operator reads them, without the emitting task's name. */
function deniedLines(log: LogCapture): readonly string[] {
  return log
    .matching("identity-mint-denied")
    .map((line) => line.slice(line.indexOf(LIFECYCLE_LOG_PREFIX)));
}

/** The bearer hash the lifecycle committed for the seeded running orb. */
function committedBearer(harness: MintHarness): string {
  const hash = harness.store.orbSnapshot(ORB)?.runtimeTokenHash;
  if (hash == null) throw new Error("seeded orb has no committed runtime token hash");
  return hash;
}

describe("identity minting across lifecycle states (DST)", () => {
  for (const state of ["creating", "starting", "running"] as const) {
    it(`mints from ${state} with the identity of that orb's live incarnation`, async () => {
      const log = new LogCapture();
      const options = { name: `mint-allowed-${state}`, iterations: 20, logCapture: log };
      await runDst(options, async (sim) => {
        const harness = makeMintHarness();
        const result = await sim.runTasks([
          {
            name: "workload",
            f: async (task) => {
              const bearer = seedOrbWithBearer(task, harness, ORB, state, { incarnation: 2 });
              const outcome = await mint(task, harness, bearer);
              const claims = decodeFakeIdToken(tokenOf(outcome, `mint from ${state}`));
              expect(claims).toEqual({
                iss: TEST_ISSUER_URL,
                aud: AUDIENCE,
                sub: ORB,
                orb_id: ORB,
                project_id: `project-of-${ORB}`,
                host_incarnation: 2,
                token_use: "exchanged",
                jti: "jti-1",
                iat: claims.iat,
                exp: claims.iat + harness.mintDeps.constants.defaultTtlSeconds,
              });
              expect(claims.iat).toBe(Math.floor(task.wallNow() / 1000));
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // A healthy mint is silent: nothing durable beyond the rate-limit
        // floor, and no operator line (docs/lifecycle.md).
        expect(log.lines()).toEqual([]);
      });
    });
  }

  const denied: readonly OrbState[] = [
    "stopped",
    "failed",
    "stopping",
    "archiving",
    "archived",
    "deleting",
  ];
  for (const state of denied) {
    it(`refuses to mint from ${state} and logs one denial edge`, async () => {
      const log = new LogCapture();
      const options = { name: `mint-denied-${state}`, iterations: 15, logCapture: log };
      await runDst(options, async (sim) => {
        const harness = makeMintHarness();
        const result = await sim.runTasks([
          {
            name: "workload",
            f: async (task) => {
              const bearer = seedOrbWithBearer(task, harness, ORB, state);
              const outcome = await mint(task, harness, bearer);
              expect(errorType(outcome)).toBe("not_mintable");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // The caller got the typed error; the operator gets exactly one line,
        // and the rate-limit slot was never consumed.
        expect(deniedLines(log)).toEqual([deniedLine("not_mintable")]);
        expect(harness.store.orbSnapshot(ORB)?.lastMintAt).toBeNull();
        expect(harness.signer.calls).toBe(0);
      });
    });
  }

  it("a hostile stream of identical denials costs one log line, not one per request", async () => {
    const log = new LogCapture();
    const options = { name: "mint-denial-log-storm", iterations: 20, logCapture: log };
    await runDst(options, async (sim) => {
      const harness = makeMintHarness();
      let bearer = "";
      const seed = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            bearer = seedOrbWithBearer(task, harness, ORB, "stopped");
          },
        },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);

      // `not_mintable` is decided before the rate-limit slot is claimed, so
      // nothing downstream throttles this: the edge dedup is the only floor a
      // caller holding a stopped orb's bearer ever meets, whatever the
      // interleaving of the eight callers.
      const storm = await sim.runTasks(
        Array.from({ length: 8 }, (_, index) => ({
          name: `attacker-${index}`,
          f: async (task: SimulationTask) => {
            for (let attempt = 0; attempt < 10; attempt++) {
              await task.sleep(1 + task.random(`denial stagger ${index}`) * 50, "denial stagger");
              expect(errorType(await mint(task, harness, bearer))).toBe("not_mintable");
            }
          },
        })),
      );
      expect(storm.isOk(), storm.isErr() ? storm.error.message : "").toBe(true);

      // Exactly one, not "a handful": the dedup is a synchronous decision on
      // in-process state, so no interleaving of the 80 requests can slip a
      // second line past it.
      expect(deniedLines(log)).toEqual([deniedLine("not_mintable")]);
    });
  });

  it("logs the denial edge again once a successful mint has re-armed it", async () => {
    const log = new LogCapture();
    const options = { name: "mint-denial-after-success", iterations: 20, logCapture: log };
    await runDst(options, async (sim) => {
      const harness = makeMintHarness();
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, harness, ORB, "stopped");
            expect(errorType(await mint(task, harness, bearer))).toBe("not_mintable");

            // The orb comes back and mints successfully. A success is silent,
            // and it re-arms the edge.
            const stopped = harness.store.orbSnapshot(ORB);
            if (stopped === null) throw new Error("seed missing");
            harness.store.seedOrb({ ...stopped, state: "running" });
            await task.sleep(harness.mintDeps.constants.minMintIntervalMs + 1, "past the floor");
            expect((await mint(task, harness, bearer)).isOk()).toBe(true);
            const healthy = harness.store.orbSnapshot(ORB);
            if (healthy === null) throw new Error("orb missing");

            // It stops again. The dedup must not suppress this on the grounds
            // that it already logged `not_mintable` once: the orb has been
            // healthy since, so this is a fresh edge the operator has to see.
            harness.store.seedOrb({ ...healthy, state: "stopped" });
            await task.sleep(1, "a moment later");
            expect(errorType(await mint(task, harness, bearer))).toBe("not_mintable");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(deniedLines(log)).toEqual([deniedLine("not_mintable"), deniedLine("not_mintable")]);
    });
  });

  it("treats an unknown, mismatched, or fenced bearer as one indistinguishable denial", async () => {
    const log = new LogCapture();
    const options = { name: "mint-unauthorized", iterations: 20, logCapture: log };
    await runDst(options, async (sim) => {
      const harness = makeMintHarness();
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, harness, ORB, "running");

            // A bearer no orb holds.
            expect(errorType(await mint(task, harness, fakeTokenHash("never-issued")))).toBe(
              "unauthorized",
            );
            // A bearer whose orb still holds its hash but is covered by a
            // discard fence: the incarnation it proves is already condemned.
            const running = harness.store.orbSnapshot(ORB);
            if (running === null) throw new Error("seed missing");
            harness.store.seedOrb({ ...running, hostDiscardThroughIncarnation: 0 });
            expect(errorType(await mint(task, harness, bearer))).toBe("unauthorized");
            // And the same orb with no committed hash at all.
            harness.store.seedOrb({ ...running, runtimeTokenHash: null });
            expect(errorType(await mint(task, harness, bearer))).toBe("unauthorized");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // Nothing at all for an unauthenticated caller: there is no orb identity
      // to log it against, and a per-orb line would say that this bearer
      // resolved to something.
      expect(deniedLines(log)).toEqual([]);
      expect(harness.store.orbSnapshot(ORB)?.lastMintAt).toBeNull();
    });
  });

  it("first boot: minting before the bearer hash commits fails, and the retry succeeds", async () => {
    await runDst({ name: "mint-first-boot", iterations: 20 }, async (sim) => {
      const harness = makeMintHarness();
      const bearer = fakeTokenHash("first-boot-token");
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            harness.store.seedProject(makeProjectRow("project-boot"));
            harness.store.seedOrb(makeOrbRow(ORB, "project-boot", "creating"));

            // The documented pre-commit boot race: the orb has its token in
            // its environment before the control plane has durably stored the
            // hash. It must be indistinguishable from any other stale bearer.
            expect(errorType(await mint(task, harness, bearer))).toBe("unauthorized");

            const committed = await harness.store.casUpdateFields(task, {
              orbId: ORB,
              expectedStateVersion: 0,
              now: task.wallNow(),
              hostRef: "host-first-boot",
              runtimeTokenHash: bearer,
            });
            expect(committed.isOk()).toBe(true);

            const outcome = await mint(task, harness, bearer);
            expect(decodeFakeIdToken(tokenOf(outcome, "post-commit mint")).orb_id).toBe(ORB);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("archive and deletion revoke minting at the moment they are requested", async () => {
    await runDst({ name: "mint-archive-delete", iterations: 20 }, async (sim) => {
      for (const command of [requestOrbArchive, requestOrbDeletion]) {
        const harness = makeMintHarness();
        const result = await sim.runTasks([
          {
            name: "workload",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const bearer = committedBearer(harness);
              expect((await mint(task, harness, bearer)).isOk()).toBe(true);

              const requested = await command(task, harness.deps, ORB);
              expect(requested.isOk(), JSON.stringify(requested)).toBe(true);

              // Revoked before any destructive cleanup runs, and no later
              // retry resurrects it.
              expect(errorType(await mint(task, harness, bearer))).toBe("not_mintable");
              await task.sleep(5_000, "past the rate-limit floor");
              expect(errorType(await mint(task, harness, bearer))).toBe("not_mintable");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      }
    });
  });

  it("one orb's bearer never mints another orb's identity", async () => {
    await runDst({ name: "mint-two-orbs", iterations: 25 }, async (sim) => {
      const harness = makeMintHarness();
      const bearers = new Map<string, string>();
      const seed = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            for (const orbId of ["orb-one", "orb-two"]) {
              bearers.set(orbId, seedOrbWithBearer(task, harness, orbId, "running"));
            }
          },
        },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);

      const minted = new Map<string, string>();
      const result = await sim.runTasks(
        ["orb-one", "orb-two"].map((orbId) => ({
          name: `workload-${orbId}`,
          f: async (task: SimulationTask) => {
            await task.sleep(1 + task.random(`stagger ${orbId}`) * 100, "cross-orb stagger");
            const bearer = bearers.get(orbId);
            if (bearer === undefined) throw new Error("missing bearer");
            const outcome = await mint(task, harness, bearer);
            const claims = decodeFakeIdToken(tokenOf(outcome, `mint for ${orbId}`));
            expect(claims.orb_id).toBe(orbId);
            expect(claims.sub).toBe(orbId);
            expect(claims.project_id).toBe(`project-of-${orbId}`);
            minted.set(orbId, claims.jti);
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // Two concurrent mints, two identities, two distinct token IDs.
      expect(new Set(minted.values()).size).toBe(2);
    });
  });
});

describe("identity minting racing lifecycle transitions (DST)", () => {
  it("no mint linearizes after the stop transition commits", async () => {
    await runDst({ name: "mint-stop-race", iterations: 30 }, async (sim) => {
      const harness = makeMintHarness({
        constants: { idleStopAfterMs: 3_600_000 },
        // The rate limit is not what this scenario is about; keep the floor
        // low so mints actually reach the lifecycle decision.
        issuerConstants: { minMintIntervalMs: 50 },
      });
      const loops = new AbortController();
      const attempts: Attempt[] = [];
      let stopObservedAt = Number.POSITIVE_INFINITY;

      const seed = await sim.runTasks([
        { name: "seed", f: async (task) => seedRunningOrb(task, harness, ORB) },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);
      const bearer = committedBearer(harness);

      const race = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, loops.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, loops.signal) },
        {
          name: "stopper",
          f: async (task) => {
            await task.sleep(200 + task.random("stop delay") * 600, "let mints start");
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk(), JSON.stringify(stopped)).toBe(true);
            // Recorded after the CAS returned, so it is never earlier than the
            // commit: any mint that *started* later must be denied.
            stopObservedAt = task.wallNow();
            await waitUntil(
              task,
              "stop converges",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
            );
            loops.abort();
          },
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          name: `minter-${index}`,
          f: async (task: SimulationTask) => {
            for (let attempt = 0; attempt < 5; attempt++) {
              await task.sleep(1 + task.random(`mint stagger ${index}`) * 300, "mint stagger");
              const startedAt = task.wallNow();
              attempts.push({ startedAt, outcome: await mint(task, harness, bearer) });
            }
          },
        })),
      ]);
      expect(race.isOk(), race.isErr() ? race.error.message : "").toBe(true);

      const after = await sim.runTasks([
        {
          name: "post-stop-minter",
          f: async (task) => {
            for (let attempt = 0; attempt < 3; attempt++) {
              await task.sleep(1_000, "past the rate-limit floor");
              const outcome = await mint(task, harness, bearer);
              expect(["not_mintable", "unauthorized"]).toContain(errorType(outcome));
            }
          },
        },
      ]);
      expect(after.isOk(), after.isErr() ? after.error.message : "").toBe(true);
      expect(attempts.length).toBe(30);
      for (const attempt of attempts) {
        if (attempt.outcome.isOk()) {
          // A mint whose snapshot read can only have happened after the stop
          // committed must never have produced a token.
          expect(attempt.startedAt).toBeLessThanOrEqual(stopObservedAt);
          continue;
        }
        // A lifecycle CAS conflict is not a shape the mint path may expose,
        // and an outage here is never our own store bug.
        expect(["not_mintable", "rate_limited", "unauthorized", "retryable"]).toContain(
          attempt.outcome.error.type,
        );
      }
      // The lifecycle itself is undisturbed by the mint traffic beside it.
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
    });
  });

  it("compute replacement rotates identity: the old bearer never mints the new incarnation", async () => {
    await runDst({ name: "mint-compute-replacement", iterations: 25 }, async (sim) => {
      const harness = makeMintHarness();
      const replacementBearer = fakeTokenHash("replacement-token-i1");
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const oldBearer = committedBearer(harness);
            const before = decodeFakeIdToken(
              tokenOf(await mint(task, harness, oldBearer), "pre-replacement mint"),
            );
            expect(before.host_incarnation).toBe(0);

            // Immutable-spec replacement: the fence goes up and the bearer is
            // revoked in the same write, while the orb is still `running`.
            const running = harness.store.orbSnapshot(ORB);
            if (running === null) throw new Error("seed missing");
            const requested = await harness.store.requestHostSpecReplacement(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              desiredFingerprint: "fake-spec-next",
              configuredGeneration: running.hostSpecGeneration ?? 0,
              now: task.wallNow(),
            });
            expect(requested.isOk() && requested.value.type).toBe("requested");
            await task.sleep(2_000, "past the rate-limit floor");
            expect(errorType(await mint(task, harness, oldBearer))).toBe("unauthorized");

            // Finalization advances the incarnation above the fence; the
            // replacement then commits its own bearer.
            const fenced = harness.store.orbSnapshot(ORB);
            if (fenced === null) throw new Error("orb missing");
            const finalized = await harness.store.finalizeHostDiscard(task, {
              orbId: ORB,
              expectedStateVersion: fenced.stateVersion,
              throughIncarnation: 0,
              now: task.wallNow(),
            });
            expect(finalized.isOk() && finalized.value.hostIncarnation).toBe(1);
            const committed = await harness.store.casUpdateFields(task, {
              orbId: ORB,
              expectedStateVersion: fenced.stateVersion,
              now: task.wallNow(),
              hostRef: "host-replacement",
              runtimeTokenHash: replacementBearer,
            });
            expect(committed.isOk(), JSON.stringify(committed)).toBe(true);

            await task.sleep(2_000, "past the rate-limit floor");
            const after = decodeFakeIdToken(
              tokenOf(await mint(task, harness, replacementBearer), "post-replacement mint"),
            );
            expect(after.host_incarnation).toBe(1);
            // Same orb, same subject: only the incarnation moved, which is
            // exactly what an incarnation-sensitive relying party checks.
            expect(after.sub).toBe(before.sub);
            expect(after.jti).not.toBe(before.jti);

            await task.sleep(2_000, "past the rate-limit floor");
            expect(errorType(await mint(task, harness, oldBearer))).toBe("unauthorized");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("no mint linearizes after a replacement's fence commits, whatever the schedule", async () => {
    await runDst({ name: "mint-replacement-race", iterations: 30 }, async (sim) => {
      const harness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 50 } });
      const replacementBearer = fakeTokenHash("replacement-token-i1");
      const attempts: Attempt[] = [];
      let fenceObservedAt = Number.POSITIVE_INFINITY;

      const seed = await sim.runTasks([
        { name: "seed", f: async (task) => seedRunningOrb(task, harness, ORB) },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);
      const oldBearer = committedBearer(harness);

      const race = await sim.runTasks([
        {
          name: "replacer",
          f: async (task) => {
            await task.sleep(200 + task.random("replacement delay") * 400, "let mints start");
            const running = harness.store.orbSnapshot(ORB);
            if (running === null) throw new Error("seed missing");
            const requested = await harness.store.requestHostSpecReplacement(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              desiredFingerprint: "fake-spec-next",
              configuredGeneration: running.hostSpecGeneration ?? 0,
              now: task.wallNow(),
            });
            expect(requested.isOk() && requested.value.type).toBe("requested");
            fenceObservedAt = task.wallNow();

            const fenced = harness.store.orbSnapshot(ORB);
            if (fenced === null) throw new Error("orb missing");
            const finalized = await harness.store.finalizeHostDiscard(task, {
              orbId: ORB,
              expectedStateVersion: fenced.stateVersion,
              throughIncarnation: 0,
              now: task.wallNow(),
            });
            expect(finalized.isOk()).toBe(true);
            const committed = await harness.store.casUpdateFields(task, {
              orbId: ORB,
              expectedStateVersion: fenced.stateVersion,
              now: task.wallNow(),
              hostRef: "host-replacement",
              runtimeTokenHash: replacementBearer,
            });
            expect(committed.isOk(), JSON.stringify(committed)).toBe(true);
          },
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          name: `minter-${index}`,
          f: async (task: SimulationTask) => {
            for (let attempt = 0; attempt < 4; attempt++) {
              await task.sleep(1 + task.random(`mint stagger ${index}`) * 250, "mint stagger");
              const startedAt = task.wallNow();
              attempts.push({ startedAt, outcome: await mint(task, harness, oldBearer) });
            }
          },
        })),
      ]);
      expect(race.isOk(), race.isErr() ? race.error.message : "").toBe(true);
      for (const attempt of attempts) {
        if (attempt.outcome.isOk()) {
          // The old bearer may only ever have minted its own incarnation, and
          // only from a read that preceded the fence.
          expect(decodeFakeIdToken(attempt.outcome.value.token).host_incarnation).toBe(0);
          expect(attempt.startedAt).toBeLessThanOrEqual(fenceObservedAt);
          continue;
        }
        expect(["unauthorized", "rate_limited", "retryable"]).toContain(attempt.outcome.error.type);
      }

      const after = await sim.runTasks([
        {
          name: "post-replacement",
          f: async (task) => {
            expect(errorType(await mint(task, harness, oldBearer))).toBe("unauthorized");
            await task.sleep(1_000, "past the rate-limit floor");
            const minted = await mint(task, harness, replacementBearer);
            expect(decodeFakeIdToken(tokenOf(minted, "replacement mint")).host_incarnation).toBe(1);
          },
        },
      ]);
      expect(after.isOk(), after.isErr() ? after.error.message : "").toBe(true);
    });
  });

  it("a failed orb's discard fence revokes minting before disposal finishes", async () => {
    await runDst({ name: "mint-failed-discard", iterations: 20 }, async (sim) => {
      const harness = makeMintHarness();
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const bearer = committedBearer(harness);
            expect((await mint(task, harness, bearer)).isOk()).toBe(true);

            const running = harness.store.orbSnapshot(ORB);
            if (running === null) throw new Error("seed missing");
            const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              now: task.wallNow(),
              lastError: "runtime_failed: test failure",
            });
            expect(failed.isOk()).toBe(true);

            await task.sleep(2_000, "past the rate-limit floor");
            // Authorization is revoked in the same atomic write that fails the
            // orb, so this is unauthorized rather than merely not mintable.
            expect(errorType(await mint(task, harness, bearer))).toBe("unauthorized");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("mint slot claims interleave a live reconciler without disturbing it", async () => {
    await runDst({ name: "mint-slot-vs-lifecycle", iterations: 25 }, async (sim) => {
      const harness = makeMintHarness({
        constants: { idleStopAfterMs: 3_600_000 },
        issuerConstants: { minMintIntervalMs: 50 },
      });
      const loops = new AbortController();
      const seen = new Set<string>();

      const seed = await sim.runTasks([
        { name: "seed", f: async (task) => seedRunningOrb(task, harness, ORB) },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);
      const bearer = committedBearer(harness);

      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, loops.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, loops.signal) },
        {
          name: "denied-minter",
          f: async (task) => {
            // A stream of denials interleaving the reconciler's reads and its
            // CAS transitions. Once the stop commits the answer becomes
            // `not_mintable` instead: the lifecycle
            // gate deliberately runs before request validation, so a stopping
            // orb never has its request inspected at all.
            for (let attempt = 0; attempt < 12; attempt++) {
              await task.sleep(1 + task.random("denial stagger") * 200, "denial stagger");
              const outcome = await mint(task, harness, bearer, { ttlSeconds: 1 });
              expect(["invalid_request", "not_mintable"]).toContain(errorType(outcome));
            }
          },
        },
        {
          name: "accepted-minter",
          f: async (task) => {
            for (let attempt = 0; attempt < 8; attempt++) {
              await task.sleep(1 + task.random("mint stagger") * 200, "mint stagger");
              const outcome = await mint(task, harness, bearer);
              if (outcome.isOk()) seen.add(decodeFakeIdToken(outcome.value.token).jti);
            }
          },
        },
        {
          name: "stopper",
          f: async (task) => {
            await task.sleep(2_500, "let the mint traffic run");
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk(), JSON.stringify(stopped)).toBe(true);
            await waitUntil(
              task,
              "stop converges under mint traffic",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
            );
            loops.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
      // Every successful mint got its own token ID, whatever the interleaving.
      expect(seen.size).toBe(harness.signer.calls);
    });
  });
});

describe("identity minting under throttling and signer failure (DST)", () => {
  it("enforces the per-orb floor and releases it once the interval passes", async () => {
    await runDst({ name: "mint-rate-limit", iterations: 20 }, async (sim) => {
      const harness = makeMintHarness();
      const floor = harness.mintDeps.constants.minMintIntervalMs;
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, harness, ORB, "running");
            expect((await mint(task, harness, bearer)).isOk()).toBe(true);

            const throttled = await mint(task, harness, bearer);
            expect(errorType(throttled)).toBe("rate_limited");
            if (throttled.isErr() && throttled.error.type === "rate_limited") {
              // Actionable, not a guess: strictly positive and never longer
              // than the floor itself.
              expect(throttled.error.retryAfterMs).toBeGreaterThan(0);
              expect(throttled.error.retryAfterMs).toBeLessThanOrEqual(floor);
            }

            await task.sleep(floor + 1, "past the rate-limit floor");
            expect((await mint(task, harness, bearer)).isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.signer.calls).toBe(2);
    });
  });

  it("admits exactly one of many simultaneous minters and bounds a hostile storm", async () => {
    await runDst({ name: "mint-storm", iterations: 30 }, async (sim) => {
      const harness = makeMintHarness();
      const floor = harness.mintDeps.constants.minMintIntervalMs;
      const jtis: string[] = [];
      let bearer = "";

      const seed = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            bearer = seedOrbWithBearer(task, harness, ORB, "running");
          },
        },
      ]);
      expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);

      // Twelve minters arriving together, all well inside one interval.
      const burst = await sim.runTasks(
        Array.from({ length: 12 }, (_, index) => ({
          name: `minter-${index}`,
          f: async (task: SimulationTask) => {
            const outcome = await mint(task, harness, bearer);
            if (outcome.isOk()) jtis.push(decodeFakeIdToken(outcome.value.token).jti);
            else expect(outcome.error.type).toBe("rate_limited");
          },
        })),
      );
      expect(burst.isOk(), burst.isErr() ? burst.error.message : "").toBe(true);
      expect(jtis.length).toBe(1);

      // A sustained storm over four intervals cannot force more mints than the
      // floor allows, whatever the schedule.
      const storm = await sim.runTasks(
        Array.from({ length: 8 }, (_, index) => ({
          name: `attacker-${index}`,
          f: async (task: SimulationTask) => {
            for (let attempt = 0; attempt < 20; attempt++) {
              await task.sleep(1 + task.random(`storm stagger ${index}`) * 200, "storm stagger");
              const outcome = await mint(task, harness, bearer);
              if (outcome.isOk()) jtis.push(decodeFakeIdToken(outcome.value.token).jti);
              else expect(outcome.error.type).toBe("rate_limited");
            }
          },
        })),
      );
      expect(storm.isOk(), storm.isErr() ? storm.error.message : "").toBe(true);

      const elapsed = 20 * 200 + floor;
      expect(jtis.length).toBeLessThanOrEqual(Math.ceil(elapsed / floor) + 1);
      expect(jtis.length).toBe(harness.signer.calls);
      // Every issued token is uniquely identifiable, which is what a relying
      // party's replay defense depends on.
      expect(new Set(jtis).size).toBe(jtis.length);
    });
  });

  it("a signer outage denies with a typed retryable error and never an unsigned token", async () => {
    const log = new LogCapture();
    await runDst(
      {
        name: "mint-signer-failpoint",
        iterations: 30,
        failpointProbabilities: { [FAILPOINTS.signerSign]: 0.4 },
        logCapture: log,
      },
      async (sim) => {
        const harness = makeMintHarness({ issuerConstants: { minMintIntervalMs: 50 } });
        const outcomes: (string | null)[] = [];
        let bearer = "";

        const seed = await sim.runTasks([
          {
            name: "seed",
            f: async (task) => {
              bearer = seedOrbWithBearer(task, harness, ORB, "running");
            },
          },
        ]);
        expect(seed.isOk(), seed.isErr() ? seed.error.message : "").toBe(true);

        const result = await sim.runTasks(
          Array.from({ length: 6 }, (_, index) => ({
            name: `workload-${index}`,
            f: async (task: SimulationTask) => {
              await task.sleep(1 + task.random(`stagger ${index}`) * 300, "signer stagger");
              const outcome = await mint(task, harness, bearer);
              outcomes.push(errorType(outcome));
              if (outcome.isOk()) {
                // Whatever failed, what comes back is always a fully formed
                // token — never an unsigned or partially built one.
                expect(decodeFakeIdToken(outcome.value.token).orb_id).toBe(ORB);
                expect(outcome.value.token.split(".").length).toBe(3);
              }
            },
          })),
        );
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);

        for (const outcome of outcomes) {
          expect(outcome === null || outcome === "retryable" || outcome === "rate_limited").toBe(
            true,
          );
        }
        // Whatever the failpoint chose, the operator only ever learns which
        // of the two expected denials happened — never an audience or a token.
        for (const line of deniedLines(log)) {
          expect([deniedLine("signer_failure"), deniedLine("rate_limited")]).toContain(line);
        }
      },
    );
  });

  it("recovers as soon as signing works again, without refunding the consumed slot", async () => {
    const log = new LogCapture();
    const options = { name: "mint-signer-recovery", iterations: 20, logCapture: log };
    await runDst(options, async (sim) => {
      const harness = makeMintHarness();
      const floor = harness.mintDeps.constants.minMintIntervalMs;
      const result = await sim.runTasks([
        {
          name: "workload",
          f: async (task) => {
            const bearer = seedOrbWithBearer(task, harness, ORB, "running");
            harness.signer.failNextSignatures(1);

            const failed = await mint(task, harness, bearer);
            expect(errorType(failed)).toBe("retryable");
            // The slot the failed mint claimed is deliberately not refunded:
            // an immediate retry is throttled like any other second mint.
            expect(harness.store.orbSnapshot(ORB)?.lastMintAt).not.toBeNull();
            expect(errorType(await mint(task, harness, bearer))).toBe("rate_limited");

            await task.sleep(floor + 1, "past the rate-limit floor");
            const recovered = await mint(task, harness, bearer);
            expect(decodeFakeIdToken(tokenOf(recovered, "post-outage mint")).orb_id).toBe(ORB);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.signer.calls).toBe(1);
      // One line per code change and nothing for the recovery: a changed code
      // is news, a repeat is not, and a success is silent.
      expect(deniedLines(log)).toEqual([deniedLine("signer_failure"), deniedLine("rate_limited")]);
    });
  });
});
