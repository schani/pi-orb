import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
} from "../testkit/fixtures.ts";
import { assertAtMostOneHost, assertReplicaComplete } from "../testkit/invariants.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

function seedCreatingOrb(
  task: SimulationTask,
  harness: ReturnType<typeof makeHarness>,
  orbId = ORB,
): void {
  harness.store.seedProject(makeProjectRow(PROJECT));
  harness.store.seedOrb(makeOrbRow(orbId, PROJECT, "creating", { stateChangedAt: task.wallNow() }));
}

describe("orb lifecycle (DST)", () => {
  it("creating reaches running with identity persisted", async () => {
    await runDst({ name: "create-happy-path", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initDurationMs: 3_000, checkoutCommit: "abc" });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb running",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.checkoutCommit).toBe("abc");
      expect(orb?.hostRef).not.toBeNull();
      expect(harness.world.hostStateOf(ORB)).toBe("running");
      assertAtMostOneHost(harness.world, ORB);
    });
  });

  it("retryable provider failures delay but do not fail creation", async () => {
    await runDst(
      {
        name: "create-with-provider-flakes",
        iterations: 30,
        failpointProbabilities: {
          [FAILPOINTS.providerProvision]: 0.3,
          [FAILPOINTS.providerObserve]: 0.2,
          [FAILPOINTS.runtimeHealth]: 0.2,
          [FAILPOINTS.storeRead]: 0.05,
          [FAILPOINTS.storeWrite]: 0.05,
        },
      },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              harness.world.configureOrb(ORB, { initDurationMs: 2_000 });
              seedCreatingOrb(task, harness);
              await waitUntil(
                task,
                "orb running despite flakes",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });

  it("two orbs share one global device-login flow and both start after completion", async () => {
    await runDst({ name: "shared-device-flow", iterations: 25 }, async (sim) => {
      const harness = makeHarness({
        authMode: { kind: "requires_login", autoCompleteAfterMs: 20_000, challengeTtlMs: 600_000 },
      });
      const stop = new AbortController();
      let challengeSeen = false;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb("orb-1", { initDurationMs: 1_000 });
            harness.world.configureOrb("orb-2", { initDurationMs: 1_000 });
            harness.store.seedProject(makeProjectRow(PROJECT));
            harness.store.seedOrb(
              makeOrbRow("orb-1", PROJECT, "creating", { stateChangedAt: task.wallNow() }),
            );
            harness.store.seedOrb(
              makeOrbRow("orb-2", PROJECT, "creating", { stateChangedAt: task.wallNow() }),
            );
            await waitUntil(task, "challenge displayed", () => {
              challengeSeen = harness.deps.control.getChallenge() !== null;
              return challengeSeen;
            });
            await waitUntil(
              task,
              "both orbs running",
              () =>
                harness.store.orbSnapshot("orb-1")?.state === "running" &&
                harness.store.orbSnapshot("orb-2")?.state === "running",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(challengeSeen).toBe(true);
      expect(harness.authGate.flowStartCount).toBe(1);
      // OAuth wait must not consume the create/start deadline: both orbs were
      // re-entered with a fresh state_changed_at before host work.
      expect(harness.store.orbSnapshot("orb-1")?.state).toBe("running");
    });
  });

  it("an expired device login fails waiting orbs with a typed error", async () => {
    await runDst({ name: "device-flow-expiry", iterations: 20 }, async (sim) => {
      const harness = makeHarness({
        authMode: {
          kind: "requires_login",
          autoCompleteAfterMs: null,
          challengeTtlMs: 15_000,
          failFlow: true,
        },
      });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB);
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb failed after login expiry",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("auth_failed");
    });
  });

  it("a control-plane restart during a pending login starts a fresh flow", async () => {
    await runDst({ name: "restart-during-login", iterations: 20 }, async (sim) => {
      const before = makeHarness({
        authMode: { kind: "requires_login", autoCompleteAfterMs: null, challengeTtlMs: 600_000 },
      });
      const stopBefore = new AbortController();
      // Phase 1: reconcile until the challenge is pending, then "crash".
      const phase1 = await sim.runTasks([
        { name: "reconciler-1", f: (task) => reconcileLoop(task, before.deps, stopBefore.signal) },
        {
          name: "driver",
          f: async (task) => {
            before.world.configureOrb(ORB, { initDurationMs: 1_000 });
            seedCreatingOrb(task, before);
            await waitUntil(task, "challenge pending", () => {
              return before.deps.control.getChallenge() !== null;
            });
            stopBefore.abort();
          },
        },
      ]);
      expect(phase1.isOk(), phase1.isErr() ? phase1.error.message : "").toBe(true);
      expect(before.authGate.flowStartCount).toBe(1);

      // Phase 2: fresh in-memory state, durable rows drive recovery. The
      // second flow auto-completes (the "user" logs in this time).
      const after = restartControlPlane(before);
      after.authGate.invalidateCredential();
      const stopAfter = new AbortController();
      // SimulationImpl is single-use; phase 2 gets its own simulation with the
      // same standard options (biased timer policy, fixed epoch).
      const { makeRecordingSimulation } = await import("../testkit/sim.ts");
      const sim2 = makeRecordingSimulation({ name: "restart-during-login-phase2" });
      // Let the fresh gate complete after a short wait.
      const phase2 = await sim2.runTasks([
        { name: "reconciler-2", f: (task) => reconcileLoop(task, after.deps, stopAfter.signal) },
        {
          name: "driver-2",
          f: async (task) => {
            await waitUntil(task, "second challenge pending", () => {
              return after.deps.control.getChallenge() !== null;
            });
            after.authGate.completeLogin();
            await waitUntil(
              task,
              "orb running after re-login",
              () => after.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 300_000 },
            );
            stopAfter.abort();
          },
        },
      ]);
      expect(phase2.isOk(), phase2.isErr() ? phase2.error.message : "").toBe(true);
      expect(after.authGate.flowStartCount).toBe(2);
    });
  });

  it("an orb stuck initializing hits the create/start deadline and fails", async () => {
    await runDst({ name: "deadline-exceeded", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initOutcome: "never_ready" });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb failed on deadline",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 600_000 },
            );
            // The host stop may have been cancelled by its own deadline; the
            // failed-state backstop reconciler then stops it shortly after.
            await waitUntil(
              task,
              "host stopped (possibly via backstop)",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("deadline_exceeded");
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("a non-retryable runtime failure fails the orb and stops the host", async () => {
    await runDst({ name: "runtime-failed", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              initDurationMs: 2_000,
              initOutcome: "failed_nonretryable",
            });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb failed",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 300_000 },
            );
            await waitUntil(
              task,
              "host stopped (possibly via backstop)",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("runtime_failed");
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("controlled stop drains every record before stopping the host", async () => {
    await runDst({ name: "stop-drains", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            for (let i = 0; i < 6; i++) harness.world.appendMessage(ORB);
            harness.world.setActivity(ORB, "busy"); // stop does not wait for idle
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertReplicaComplete(harness.world, harness.store, ORB);
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("a retryably failing drain never stops the host until it succeeds", async () => {
    await runDst({ name: "drain-blocked-retryable", iterations: 25 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const violations: string[] = [];
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            harness.world.appendMessage(ORB);
            // Database outage for the whole early drain window.
            harness.world.setPullOutage(task, ORB, 6_000);
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped after outage",
              () => {
                const state = harness.store.orbSnapshot(ORB)?.state;
                const replicated = harness.store.replicaRecords(ORB).length;
                // Invariant: the orb may not transition to `stopped` while
                // records remain undrained. (A host stop+start restart for an
                // unreachable runtime during stopping is legal, so the host
                // state alone is not the invariant.)
                if (state === "stopped" && replicated !== 2) {
                  violations.push(`orb stopped with ${replicated}/2 records replicated`);
                }
                return state === "stopped";
              },
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(violations).toEqual([]);
      assertReplicaComplete(harness.world, harness.store, ORB);
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("an integrity failure during drain stops the host and fails the orb", async () => {
    await runDst({ name: "drain-integrity", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            // The session must be replicated first, or the corrupt header
            // would legitimately become the initial stored session.
            await waitUntil(
              task,
              "session stored",
              () => harness.store.orbSnapshot(ORB)?.harnessSessionId !== null,
            );
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            // Corrupt after the stop request: the poller skips stopping orbs,
            // so the drain itself hits the mismatch.
            harness.world.corruptSession(ORB);
            await waitUntil(
              task,
              "orb failed during drain",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 300_000 },
            );
            await waitUntil(
              task,
              "host stopped (possibly via backstop)",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("replication_integrity");
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("stopping an orb that never became ready skips the drain", async () => {
    await runDst({ name: "stop-never-ready", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initOutcome: "never_ready" });
            seedCreatingOrb(task, harness);
            // Give reconciliation a moment to provision the host.
            await waitUntil(task, "host exists", () => harness.world.hostStateOf(ORB) !== null, {
              timeoutMs: 120_000,
            });
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped without drain",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("an absent or already-stopped host during stopping is marked stopped directly", async () => {
    await runDst({ name: "stop-absent-host", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB); // will remain unreplicated: accepted caveat
            // Host dies out from under us (e.g. crashed while stopping).
            const orb = harness.store.orbSnapshot(ORB);
            expect(orb?.hostRef).not.toBeNull();
            harness.world.stopHost({ provider: "fake", resourceId: orb?.hostRef ?? "" });
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped despite dead host",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
    });
  });

  it("an unreachable runtime in a live host is restarted after the grace period", async () => {
    await runDst({ name: "unreachable-restart", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "initial replication",
              () => harness.store.replicaRecords(ORB).length === 1,
            );
            const firstInstance = harness.world.runtimeInstanceIdOf(ORB);
            harness.world.killRuntimeProcess(ORB);
            await waitUntil(
              task,
              "host restarted with a new runtime",
              () => {
                const instance = harness.world.runtimeInstanceIdOf(ORB);
                return instance !== null && instance !== firstInstance;
              },
              { timeoutMs: 300_000 },
            );
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "replication resumes",
              () => harness.store.replicaRecords(ORB).length === 2,
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
      assertReplicaComplete(harness.world, harness.store, ORB);
    });
  });

  it("an unexpectedly stopped host while running is restored", async () => {
    await runDst({ name: "host-vanishes", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const orb = harness.store.orbSnapshot(ORB);
            harness.world.stopHost({ provider: "fake", resourceId: orb?.hostRef ?? "" });
            await waitUntil(
              task,
              "host restored and orb running again",
              () =>
                harness.world.hostStateOf(ORB) === "running" &&
                harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertAtMostOneHost(harness.world, ORB);
    });
  });

  it("competing reconcilers are harmless thanks to state_version CAS", async () => {
    await runDst({ name: "competing-reconcilers", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler-1", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "reconciler-2", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initDurationMs: 2_000 });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb running",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 300_000 },
            );
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertAtMostOneHost(harness.world, ORB);
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("a stray running host of a stopped orb is reconciled back to stopped", async () => {
    await runDst({ name: "stopped-host-backstop", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedProject(makeProjectRow(PROJECT));
            harness.world.configureOrb(ORB, { initDurationMs: 0 });
            const ref = harness.world.provisionHost(task, ORB); // stray host
            harness.store.seedOrb(makeOrbRow(ORB, PROJECT, "stopped", { hostRef: ref.resourceId }));
            await waitUntil(
              task,
              "stray host stopped",
              () => harness.world.hostStateOf(ORB) === "stopped",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
    });
  });
});
