import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
  TEST_CONSTANTS,
} from "../testkit/fixtures.ts";
import { assertAtMostOneHost, assertReplicaComplete } from "../testkit/invariants.ts";
import { makeRecordingSimulation, runDst, waitUntil } from "../testkit/sim.ts";
import { requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

/**
 * Recovering one dead runtime may cost a restart (one stop) plus the final
 * stop of a completed drain; anything beyond that is a restart storm, not
 * recovery (docs/postmortems/2026-08-05-unreachable-restart-livelock.md).
 */
const MAX_STOPS_PER_RECOVERY = 3;

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
        // Both orbs must be running at the same instant, so the poll loop has
        // to run: pulls are the liveness signal, and without them the
        // reconciler correctly restarts each orb's host every grace period.
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
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
      let sessionCorrupted = false;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            await waitUntil(task, "session corrupted", () => sessionCorrupted);
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
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
            sessionCorrupted = true;
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
      // Idle auto-stop is out of scope here: the scenario generates no busy
      // activity, and adversarial schedules can stretch kill + grace + restart
      // past the test idle window, legitimately stopping the orb (trace-
      // diagnosed 2026-08-03). The restart mechanism is what's under test: the
      // restart is issued and replication resumes on the new incarnation, which
      // now costs a full modeled boot through `starting`.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
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

  // The reproducer for docs/postmortems/2026-08-05-unreachable-restart-livelock.md:
  // before the 2026-08-06 fix the reconciler stopped and started the host every
  // `unreachableGraceMs` (10s here) while the replacement boot needs the modeled
  // 65s, so it never observed a success — 14 of 15 recorded schedules livelocked
  // in the 38-cycle production shape. Recovery now runs through `starting`.
  it("a preempted host recovers without a restart storm", async () => {
    await runDst({ name: "preemption-while-running", iterations: 15 }, async (sim) => {
      // Idle auto-stop is deliberately out of scope: recovering from a
      // preemption legitimately takes longer than the 30s test idle window (a
      // modeled boot alone is 65s), so leaving it on would stop the orb for an
      // unrelated and correct reason and hide what is under test. In
      // production it was idle-stop that eventually dragged the livelocking
      // orb into `stopping` and then into `drain_runtime_unrecoverable`; the
      // `running`-state loop it escaped from has no deadline of its own, which
      // is precisely the defect this scenario pins down.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            // Boot latency stays in force: the restart after the preemption is
            // a full host boot, which is the point of the scenario.
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "initial replication",
              () => harness.store.replicaRecords(ORB).length === 1,
            );
            const stopsBefore = harness.world.hostStopCountOf(ORB);
            const stopsSince = (): number => harness.world.hostStopCountOf(ORB) - stopsBefore;
            // Hypervisor soft-off: the runtime is gone at once, the instance
            // keeps observing `running` for its ACPI window.
            harness.world.preemptHost(task, ORB);
            let stopStorm: number | null = null;
            await waitUntil(
              task,
              "orb running on a serving runtime again",
              () => {
                if (stopsSince() > MAX_STOPS_PER_RECOVERY) {
                  // Fail the scenario at the first excess stop instead of
                  // burning the whole budget on a livelock.
                  stopStorm = stopsSince();
                  return true;
                }
                return (
                  harness.store.orbSnapshot(ORB)?.state === "running" &&
                  harness.world.isRuntimeServing(task, ORB)
                );
              },
              { timeoutMs: 20 * 60_000 },
            );
            expect(stopStorm, "provider stops issued while recovering").toBeNull();
            // Recovery means replication, not just a state label.
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "replication resumes on the recovered runtime",
              () => harness.store.replicaRecords(ORB).length === 2,
              { timeoutMs: 300_000 },
            );
            expect(stopsSince()).toBeLessThanOrEqual(MAX_STOPS_PER_RECOVERY);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
      assertReplicaComplete(harness.world, harness.store, ORB);
      assertAtMostOneHost(harness.world, ORB);
    });
  });

  // The `stopping` half of the same postmortem: before the 2026-08-06 fix the
  // inline restart livelocked here too and the drain deadline turned it into a
  // terminal `drain_runtime_unrecoverable` with three undrained records — the
  // exact ending of the production incident. The single restart now gets a
  // boot-sized grace, so the drain completes on the rebooted runtime.
  it("a runtime that dies during a drain still completes the stop", async () => {
    await runDst({ name: "runtime-dies-during-stopping-drain", iterations: 15 }, async (sim) => {
      // Idle auto-stop is left at its default: the orb is put into `stopping`
      // explicitly within the first tick, so the idle path can never engage.
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            // Boot latency stays in force for the restart the drain triggers.
            seedRunningOrb(task, harness, ORB);
            for (let i = 0; i < 3; i++) harness.world.appendMessage(ORB);
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            // Nothing has been replicated yet (no poller), so the drain has
            // real work when the runtime process dies under it.
            expect(harness.store.replicaRecords(ORB).length).toBe(0);
            const stopsBefore = harness.world.hostStopCountOf(ORB);
            harness.world.killRuntimeProcess(ORB);
            await waitUntil(
              task,
              "orb reaches a terminal state",
              () => {
                const state = harness.store.orbSnapshot(ORB)?.state;
                return state === "stopped" || state === "failed";
              },
              { timeoutMs: 20 * 60_000 },
            );
            expect(harness.world.hostStopCountOf(ORB) - stopsBefore).toBeLessThanOrEqual(
              MAX_STOPS_PER_RECOVERY,
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.lastError).toBeNull();
      expect(orb?.state).toBe("stopped");
      assertReplicaComplete(harness.world, harness.store, ORB);
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("a drain whose restarted runtime never answers fails on evidence, not on the deadline", async () => {
    await runDst({ name: "stopping-restart-cap", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      let stoppingAt = 0;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            for (let i = 0; i < 3; i++) harness.world.appendMessage(ORB);
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            stoppingAt = task.wallNow();
            const stopsBefore = harness.world.hostStopCountOf(ORB);
            // Dark for far longer than a boot plus the post-restart grace: the
            // restarted host comes up and still answers nothing.
            harness.world.setRuntimeUnreachable(task, ORB, 20 * 60_000);
            await waitUntil(
              task,
              "orb failed",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 20 * 60_000 },
            );
            // One restart, then the terminal stop: no second attempt.
            expect(harness.world.hostStopCountOf(ORB) - stopsBefore).toBeLessThanOrEqual(2);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.lastError).toContain("drain_runtime_unrecoverable");
      // Evidence-based: the restart is what proved the runtime unrecoverable,
      // so the failure lands well inside the stopping deadline.
      expect(orb?.lastError).toContain("host restart");
      expect((orb?.stateChangedAt ?? 0) - stoppingAt).toBeLessThan(
        TEST_CONSTANTS.createStartDeadlineMs,
      );
    });
  });

  it("an unexpectedly stopped host while running is restored", async () => {
    await runDst({ name: "host-vanishes", iterations: 20 }, async (sim) => {
      // Same idle-stop opt-out as unreachable-restart: no activity here, and
      // an idle stop mid-recovery would turn the wait-for-running into a
      // timeout. Host restoration is what's under test.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
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

  it("an orb with no replicated history survives stop and restart", async () => {
    await runDst({ name: "empty-history-restart", iterations: 20 }, async (sim) => {
      // The 2026-08-03 incident shape (docs/history-replication.md): nothing replicated
      // yet — with the snapshot gate, a never-flushed session serves zero
      // records — then the orb stops and restarts. Replication must resume
      // cleanly from the null cursor instead of stranding the orb. Idle
      // auto-stop is out of scope here (see unreachable-restart).
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped with empty history",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            expect(harness.store.replicaRecords(ORB).length).toBe(0);
            const startResult = await requestOrbStart(task, harness.deps, ORB);
            expect(startResult.isOk()).toBe(true);
            await waitUntil(
              task,
              "orb running again",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 300_000 },
            );
            harness.world.appendMessage(ORB);
            await waitUntil(
              task,
              "late record replicated",
              () => harness.store.replicaRecords(ORB).length === 1,
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
            const provisioned = harness.world.provisionHost(task, ORB); // stray host
            harness.store.seedOrb(
              makeOrbRow(ORB, PROJECT, "stopped", { hostRef: provisioned.ref.resourceId }),
            );
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

describe("idle auto-stop (DST)", () => {
  it("stops an idle orb after the idle deadline with reason idle", async () => {
    await runDst({ name: "idle-stop-happy-path", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      let seededAt = 0;
      let firstStopSeenAt: number | null = null;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            seededAt = task.wallNow();
            await waitUntil(
              task,
              "idle orb stopped",
              () => {
                const state = harness.store.orbSnapshot(ORB)?.state;
                // Only the stop edge is timed: a scheduler-legal liveness lapse
                // restarts the host, which legitimately parks the orb in
                // `starting` for a boot and restarts the idle countdown.
                if ((state === "stopping" || state === "stopped") && firstStopSeenAt === null) {
                  firstStopSeenAt = task.wallNow();
                }
                return state === "stopped";
              },
              { timeoutMs: 600_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.state).toBe("stopped");
      expect(orb?.stopReason).toBe("idle");
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
      // The stop must not fire before the idle deadline has elapsed.
      expect(firstStopSeenAt).not.toBeNull();
      expect((firstStopSeenAt ?? 0) - seededAt).toBeGreaterThanOrEqual(
        TEST_CONSTANTS.idleStopAfterMs,
      );
    });
  });

  it("a busy runtime never idle-stops", async () => {
    await runDst({ name: "idle-stop-busy-blocks", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            // Keep the runtime busy in pull-sized steps: a single long sleep
            // lets the scheduler leap virtual time past the unreachable grace
            // (host restart, which correctly resets a real runtime to idle),
            // and a restarted runtime going idle is *supposed* to stop.
            const rounds = Math.ceil(
              (3 * TEST_CONSTANTS.idleStopAfterMs) / TEST_CONSTANTS.historyPullIntervalMs,
            );
            for (let i = 0; i < rounds; i++) {
              harness.world.setActivity(ORB, "busy");
              await task.sleep(TEST_CONSTANTS.historyPullIntervalMs, "stay busy");
              // The subject is the absence of an idle stop, not the state
              // label: a liveness lapse may legally restart the host, which
              // spends a boot in `starting` before returning to `running`.
              const state = harness.store.orbSnapshot(ORB)?.state;
              expect(state === "stopping" || state === "stopped").toBe(false);
            }
            // A busy pull must have landed and persisted its timestamp; a
            // restart in the middle only delays that.
            await waitUntil(
              task,
              "busy activity persisted on a running orb",
              () => {
                harness.world.setActivity(ORB, "busy");
                const orb = harness.store.orbSnapshot(ORB);
                expect(orb?.state === "stopping" || orb?.state === "stopped").toBe(false);
                return orb?.state === "running" && orb.lastBusyAt !== null;
              },
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.world.hostStateOf(ORB)).toBe("running");
      // The busy pulls persisted the activity timestamp along the way.
      expect(harness.store.orbSnapshot(ORB)?.lastBusyAt).not.toBeNull();
    });
  });

  it("a visible tab blocks the idle stop; hiding it restarts the countdown", async () => {
    await runDst({ name: "idle-stop-visible-tab", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      let hiddenAt = 0;
      let firstStopSeenAt: number | null = null;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            // What the live proxy does when a tab connects and reports visible.
            harness.deps.control.registerBrowserConnection(ORB, "tab-1");
            harness.deps.control.setBrowserVisibility(ORB, "tab-1", true, task.wallNow());
            // Watch in pull-sized steps (a single long sleep lets the
            // scheduler leap past the unreachable grace and restart the
            // host): while the tab is visible the orb must never stop.
            const rounds = Math.ceil(
              (2 * TEST_CONSTANTS.idleStopAfterMs) / TEST_CONSTANTS.historyPullIntervalMs,
            );
            for (let i = 0; i < rounds; i++) {
              await task.sleep(TEST_CONSTANTS.historyPullIntervalMs, "watching the idle orb");
              const state = harness.store.orbSnapshot(ORB)?.state;
              expect(state === "stopping" || state === "stopped").toBe(false);
            }
            hiddenAt = task.wallNow();
            harness.deps.control.setBrowserVisibility(ORB, "tab-1", false, hiddenAt);
            await waitUntil(
              task,
              "orb stopped after tab hidden",
              () => {
                const state = harness.store.orbSnapshot(ORB)?.state;
                // As above: `starting` is a restart, not a stop.
                if ((state === "stopping" || state === "stopped") && firstStopSeenAt === null) {
                  firstStopSeenAt = task.wallNow();
                }
                return state === "stopped";
              },
              { timeoutMs: 600_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.stopReason).toBe("idle");
      // Hiding the tab starts a fresh full countdown from the hide.
      expect(firstStopSeenAt).not.toBeNull();
      expect((firstStopSeenAt ?? 0) - hiddenAt).toBeGreaterThanOrEqual(
        TEST_CONSTANTS.idleStopAfterMs,
      );
    });
  });

  it("a message racing the idle deadline never loses records", async () => {
    await runDst(
      {
        name: "idle-stop-message-race",
        iterations: 25,
        failpointProbabilities: {
          [FAILPOINTS.storeWrite]: 0.05,
          [FAILPOINTS.providerObserve]: 0.1,
        },
      },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              // One flushed record up front so the long idle stretch cannot
              // evaporate the session: a runtime restart of a session that
              // never flushed mints a fresh session identity (the
              // docs/history-replication.md contract), which would break the
              // burst below on an unrelated axis (trace-diagnosed 2026-08-05).
              harness.world.appendMessage(ORB);
              // Land a burst of work right at the idle deadline so the busy
              // refresh races the CAS into stopping.
              await task.sleep(
                TEST_CONSTANTS.idleStopAfterMs - 1_000,
                "wait until just before the idle deadline",
              );
              for (let i = 0; i < 4; i++) harness.world.appendMessage(ORB);
              harness.world.setActivity(ORB, "busy");
              await task.sleep(3 * TEST_CONSTANTS.historyPullIntervalMs, "let the burst replicate");
              harness.world.setActivity(ORB, "idle");
              // Whichever side won the race, the orb ends stopped with every
              // record drained.
              await waitUntil(
                task,
                "orb stopped after the race",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                { timeoutMs: 600_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertReplicaComplete(harness.world, harness.store, ORB);
        expect(harness.world.hostStateOf(ORB)).toBe("stopped");
      },
    );
  });

  it("survives a control-plane restart on persisted state alone", async () => {
    await runDst({ name: "idle-stop-across-restart", iterations: 10 }, async (sim) => {
      const before = makeHarness();
      const stopBefore = new AbortController();
      let crashWall = 0;
      const phase1 = await sim.runTasks([
        { name: "reconciler-1", f: (task) => reconcileLoop(task, before.deps, stopBefore.signal) },
        { name: "poller-1", f: (task) => pollLoop(task, before.deps, stopBefore.signal) },
        {
          name: "driver-1",
          f: async (task) => {
            seedRunningOrb(task, before, ORB);
            before.world.setActivity(ORB, "busy");
            await waitUntil(
              task,
              "busy activity persisted",
              () => before.store.orbSnapshot(ORB)?.lastBusyAt !== null,
              { timeoutMs: 60_000 },
            );
            before.world.setActivity(ORB, "idle");
            crashWall = task.wallNow();
            stopBefore.abort();
          },
        },
      ]);
      expect(phase1.isOk(), phase1.isErr() ? phase1.error.message : "").toBe(true);
      const persistedLastBusy = before.store.orbSnapshot(ORB)?.lastBusyAt ?? null;
      expect(persistedLastBusy).not.toBeNull();
      expect(before.store.orbSnapshot(ORB)?.state).toBe("running");

      // Restart: fresh in-memory state, 10s of downtime, same durable rows.
      const after = restartControlPlane(before);
      const stopAfter = new AbortController();
      const sim2 = makeRecordingSimulation({
        name: "idle-stop-across-restart-phase2",
        wallClockEpoch: crashWall + 10_000,
      });
      let firstStopSeenAt: number | null = null;
      const phase2 = await sim2.runTasks([
        { name: "reconciler-2", f: (task) => reconcileLoop(task, after.deps, stopAfter.signal) },
        { name: "poller-2", f: (task) => pollLoop(task, after.deps, stopAfter.signal) },
        {
          name: "driver-2",
          f: async (task) => {
            await waitUntil(
              task,
              "orb idle-stopped after restart",
              () => {
                const state = after.store.orbSnapshot(ORB)?.state;
                // Only the stop edge is timed; `starting` is a restart.
                if ((state === "stopping" || state === "stopped") && firstStopSeenAt === null) {
                  firstStopSeenAt = task.wallNow();
                }
                return state === "stopped";
              },
              { timeoutMs: 600_000 },
            );
            stopAfter.abort();
          },
        },
      ]);
      expect(phase2.isOk(), phase2.isErr() ? phase2.error.message : "").toBe(true);
      expect(after.store.orbSnapshot(ORB)?.stopReason).toBe("idle");
      // The persisted timestamp — not the restart — anchors the deadline: the
      // stop never fires before last_busy_at + idleStopAfterMs even though
      // all in-memory state was lost.
      expect(firstStopSeenAt).not.toBeNull();
      expect(firstStopSeenAt ?? 0).toBeGreaterThanOrEqual(
        (persistedLastBusy ?? 0) + TEST_CONSTANTS.idleStopAfterMs,
      );
    });
  });
});
