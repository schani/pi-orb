import type { HistoryRecord } from "@pi-orb/protocol";
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
import { LogCapture, makeRecordingSimulation, runDst, waitUntil } from "../testkit/sim.ts";
import { isDeclineMarker, isResumeMarker } from "../testkit/world.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollAllOnce, pollLoop, reconcileLoop } from "./loops.ts";
import type { ControlPlaneDeps } from "./ports.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

/**
 * Recovering one dead runtime may cost a restart (one stop) plus the final
 * stop of a completed drain; anything beyond that is a restart storm, not
 * recovery (docs/postmortems/2026-08-05-unreachable-restart-livelock.md).
 */
const MAX_STOPS_PER_RECOVERY = 3;

/**
 * The queue message IDs carried by a replicated inbox record (the runtime's
 * `pi-orb.user-message` custom message), empty for every other record.
 */
function inboxMessageIdsOf(record: HistoryRecord): readonly string[] {
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return [];
  const details = native["details"];
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  const ids = details["messageIds"];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}

/** The replicated inbox records carrying `messageId`, in replica order. */
function inboxRecordsFor(records: readonly HistoryRecord[], messageId: string): HistoryRecord[] {
  return records.filter((record) => inboxMessageIdsOf(record).includes(messageId));
}

/**
 * The exactly-once invariant of the send-anytime inbox, checked on both sides
 * of the delivery boundary: every message ID is marked `delivered` in
 * PostgreSQL, appears in exactly one replicated record, and — the part the
 * replica alone cannot prove — appears in exactly one record of the runtime's
 * own session, so a redelivery that started a second agent turn is caught even
 * when replication has not observed it yet.
 */
function assertInboxDeliveredExactlyOnce(
  harness: ReturnType<typeof makeHarness>,
  orbId: string,
  messageIds: readonly string[],
): void {
  const snapshots = harness.store.messageSnapshots(orbId);
  const replicated = harness.store.replicaRecords(orbId);
  const session = harness.world.entriesOf(orbId).flatMap(inboxMessageIdsOf);
  for (const messageId of messageIds) {
    expect(
      snapshots.find((message) => message.messageId === messageId)?.status,
      `${messageId} delivered`,
    ).toBe("delivered");
    expect(
      inboxRecordsFor(replicated, messageId),
      `one replicated record for ${messageId}`,
    ).toHaveLength(1);
    expect(
      session.filter((id) => id === messageId),
      `one session record for ${messageId}`,
    ).toHaveLength(1);
  }
  // No message ID appears in two runtime records at all, whether or not the
  // scenario named it.
  expect(new Set(session).size, "no message delivered twice").toBe(session.length);
}

/** FIFO: the replicated records carrying `messageIds` are in that order. */
function assertInboxFifo(
  harness: ReturnType<typeof makeHarness>,
  orbId: string,
  messageIds: readonly string[],
): void {
  const records = harness.store.replicaRecords(orbId);
  const positions = messageIds.map((messageId) =>
    records.findIndex((record) => inboxMessageIdsOf(record).includes(messageId)),
  );
  for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
  // Squashed batches share one record, so equal positions are FIFO too.
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index - 1] ?? -1).toBeLessThanOrEqual(positions[index] ?? -1);
  }
}

/**
 * Wait `totalMs` in short steps. One long timer is not a long wait to this
 * scheduler: its late-firing exploration may pick that timer and teleport
 * virtual time past every other deadline in the simulation at once — here it
 * starved the history poller for a full minute and produced an
 * `unreachable-restart` no stalled caller could have caused (2026-08-11; the
 * same reasoning as `HANG_STEP_MS` in testkit/world.ts).
 */
async function sleepInSteps(task: SimulationTask, totalMs: number, reason: string): Promise<void> {
  const until = task.monotonicNow() + totalMs;
  while (task.monotonicNow() < until) {
    await task.sleep(Math.min(until - task.monotonicNow(), 500), reason);
  }
}

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

  it("fails closed when provider observation carries the wrong incarnation", async () => {
    await runDst({ name: "observed-incarnation-mismatch", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const row = harness.store.orbSnapshot(ORB);
            expect(row).not.toBeNull();
            if (row === null) return;
            harness.store.seedOrb({ ...row, hostIncarnation: 1 });

            await waitUntil(
              task,
              "incarnation mismatch failed closed",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
            );
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "failed",
              runtimeTokenHash: null,
              hostDiscardThroughIncarnation: 1,
              hostDiscardReason: "failed",
            });
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
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
        // This scenario asserts that both independently booted orbs overlap in
        // running after sharing auth. Its modeled 65s boots can legitimately
        // outlast the ordinary 30s test idle window, so idle-stop is outside
        // this scenario rather than an accidental race against its assertion.
        constants: { idleStopAfterMs: 600_000 },
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
              "auth failure disposal finalized",
              () => {
                const row = harness.store.orbSnapshot(ORB);
                return (
                  row?.state === "failed" &&
                  row.hostDiscardThroughIncarnation === null &&
                  row.hostIncarnation === 1
                );
              },
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)).toMatchObject({
        lastError: expect.stringContaining("auth_failed"),
        hostDiscardEvidence: "diagnosis unavailable: no compute reference",
        hostIncarnation: 1,
        hostRef: null,
      });
      expect(harness.world.hostCount(ORB)).toBe(0);
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
            await waitUntil(
              task,
              "failed compute discarded",
              () =>
                harness.world.hostStateOf(ORB) === null &&
                harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("deadline_exceeded");
      expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(1);
      expect(harness.world.hostStateOf(ORB)).toBeNull();
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
            harness.world.setDiagnosis(ORB, "container_status=exited restart_count=7 exit_code=42");
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb failed",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 300_000 },
            );
            await waitUntil(
              task,
              "failed compute discarded",
              () =>
                harness.world.hostStateOf(ORB) === null &&
                harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const terminal = harness.store.orbSnapshot(ORB);
      expect(terminal?.lastError).toContain("runtime_failed: session_load_failed: session corrupt");
      expect(terminal?.hostDiscardEvidence).toMatch(
        /^(container_status=exited restart_count=7 exit_code=42|diagnosis unavailable:)/,
      );
      if (!terminal?.hostDiscardEvidence?.startsWith("diagnosis unavailable:")) {
        expect(terminal?.lastError).toContain(`host_evidence: ${terminal?.hostDiscardEvidence}`);
      }
      expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(1);
      expect(harness.world.hostStateOf(ORB)).toBeNull();
    });
  });

  it("a retryable-labelled terminal clone failure fails promptly with its explanation", async () => {
    await runDst({ name: "terminal-clone-failure", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      let failedAfterMs = Number.POSITIVE_INFINITY;
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, {
              initDurationMs: 2_000,
              initOutcome: "failed_retryable",
            });
            seedCreatingOrb(task, harness);
            const createdAt = harness.store.orbSnapshot(ORB)?.stateChangedAt ?? task.wallNow();
            await waitUntil(
              task,
              "orb failed on terminal clone error",
              () => harness.store.orbSnapshot(ORB)?.state === "failed",
              { timeoutMs: 120_000 },
            );
            const failed = harness.store.orbSnapshot(ORB);
            failedAfterMs = (failed?.stateChangedAt ?? task.wallNow()) - createdAt;
            expect(failed?.lastError).toBe("runtime_failed: clone_failed: network flake");
            expect(failed?.checkoutCommit).toBeNull();
            expect(failedAfterMs).toBeLessThan(TEST_CONSTANTS.createStartDeadlineMs);
            await waitUntil(
              task,
              "failed compute discarded after terminal clone error",
              () =>
                harness.world.hostStateOf(ORB) === null &&
                harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(failedAfterMs).toBeLessThan(TEST_CONSTANTS.createStartDeadlineMs);
      expect(harness.store.orbSnapshot(ORB)?.lastError).not.toContain("deadline_exceeded");
      expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(1);
      expect(harness.world.hostStateOf(ORB)).toBeNull();
    });
  });

  it("controlled stop drains every record before stopping the host", async () => {
    const capture = new LogCapture();
    await runDst({ name: "stop-drains", iterations: 30, logCapture: capture }, async (sim) => {
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
            let proxyCloseCalls = 0;
            harness.deps.control.registerBrowserConnection(ORB, "terminal-1", () => {
              proxyCloseCalls += 1;
            });
            const stopResult = await requestOrbStop(task, harness.deps, ORB);
            expect(stopResult.isOk()).toBe(true);
            expect(proxyCloseCalls).toBe(1);
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
      // The stop is fully narrated, and the terminal transition exactly once.
      expect(capture.matching("drain-caught-up").length).toBeGreaterThanOrEqual(1);
      expect(capture.matching("to=stopped").length).toBe(1);
      expect(capture.matching("to=stopping reason=stop_requested").length).toBe(1);
    });
  });

  it("a message queued on a stopped orb starts it and is replicated exactly once", async () => {
    await runDst({ name: "stopped-message-starts", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000123";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk()).toBe(true);
            await waitUntil(
              task,
              "initial stop completes",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "continue from offline" }],
              now: task.wallNow(),
            });
            // Admission records the wake intent only; the reconciler's
            // backstop performs the one message-driven transition.
            expect(queued.isOk() && queued.value.orb.state).toBe("stopped");
            expect(queued.isOk() && queued.value.message.autoStart).toBe(true);
            await waitUntil(
              task,
              "the wake intent starts the orb",
              () => harness.store.orbSnapshot(ORB)?.state !== "stopped",
              { timeoutMs: 60_000 },
            );
            await waitUntil(
              task,
              "queued message reaches the runtime session",
              () =>
                harness.store.messageSnapshots(ORB)[0]?.status === "delivered" &&
                harness.store.replicaRecords(ORB).some((record) => {
                  const native = record.overflow["native"];
                  if (typeof native !== "object" || native === null || Array.isArray(native)) {
                    return false;
                  }
                  const details = native["details"];
                  return (
                    typeof details === "object" &&
                    details !== null &&
                    !Array.isArray(details) &&
                    Array.isArray(details["messageIds"]) &&
                    details["messageIds"].includes(messageId)
                  );
                }),
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const records = harness.store.replicaRecords(ORB);
      expect(
        records.filter((record) => {
          const native = record.overflow["native"];
          if (typeof native !== "object" || native === null || Array.isArray(native)) return false;
          const details = native["details"];
          return (
            typeof details === "object" &&
            details !== null &&
            !Array.isArray(details) &&
            Array.isArray(details["messageIds"]) &&
            details["messageIds"].includes(messageId)
          );
        }),
      ).toHaveLength(1);
    });
  });

  // Two forced interleavings, because this scenario asserts two things the
  // design does not otherwise order:
  //
  // 1. The batch boundary is decided by *when the reconciler claims*, and
  //    nothing guarantees two separately awaited enqueues land in the same
  //    claim: free-running, ~1 schedule in 200 claims the first message alone
  //    and delivers two batches (reproduced 2026-08-10 at iteration 197 of
  //    400 — both messages arrive, FIFO and content intact, as two records).
  //    The reconciler is therefore held until both messages are durable, which
  //    makes a single claim the only possible outcome.
  // 2. `delivery` ("steer" vs "turn") is written by the delivery note, which
  //    replication can overtake: a pull that commits the inbox record first
  //    marks the rows `delivered`, and the note — which only touches
  //    queued/delivering rows — then matches nothing, so the classification is
  //    lost for good (~1 schedule in 20 000, found here 2026-08-10; the defect
  //    itself is in TODO.md). The poller is held until the note is durable so
  //    this scenario measures batching, not that race.
  it("two messages queued while busy are delivered as one squashed steering message", async () => {
    await runDst({ name: "busy-message-steers", iterations: 15 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000124";
      const secondMessageId = "00000000-0000-4000-8000-000000000125";
      let bothQueued = false;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            await waitUntil(task, "both messages queued", () => bothQueued);
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
        {
          name: "poller",
          f: async (task) => {
            await waitUntil(task, "the delivery note is durable", () => {
              const first = harness.store.messageSnapshots(ORB)[0];
              return first !== undefined && first.delivery !== null;
            });
            await pollLoop(task, harness.deps, stop.signal);
          },
        },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "change direction" }],
              now: task.wallNow(),
            });
            expect(queued.isOk()).toBe(true);
            const secondQueued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: secondMessageId,
              content: [{ type: "text", text: "and also check tests" }],
              now: task.wallNow(),
            });
            expect(secondQueued.isOk()).toBe(true);
            bothQueued = true;
            await waitUntil(
              task,
              "both busy messages are accepted as one steering message",
              () => {
                const messages = harness.store.messageSnapshots(ORB);
                const message = messages[0];
                return (
                  message?.delivery === "steer" &&
                  message.status === "delivered" &&
                  messages[1]?.status === "delivered" &&
                  harness.store.replicaRecords(ORB).some((record) => {
                    const ids = inboxMessageIdsOf(record);
                    return (
                      ids.includes(messageId) &&
                      ids.includes(secondMessageId) &&
                      record.type === "message" &&
                      record.content.some(
                        (block) =>
                          block.type === "text" &&
                          block.text === "change direction\n\nand also check tests",
                      )
                    );
                  })
                );
              },
              { timeoutMs: 60_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.messageSnapshots(ORB)[0]?.delivery).toBe("steer");
      // One claim, one delivery: each message reached the runtime exactly once.
      const records = harness.store.replicaRecords(ORB);
      expect(inboxRecordsFor(records, messageId)).toHaveLength(1);
      expect(inboxRecordsFor(records, secondMessageId)).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------
  // The durable message inbox, as the per-orb reconciler owns it
  // (docs/control-plane-api.md, docs/lifecycle.md). Each scenario below pins
  // one contract the queue must keep no matter what the runtime or the store
  // answers, and forces its interleaving (a held reconciler, a scripted
  // one-shot store blip) instead of hoping for one.

  it("a message the runtime rejects for good fails and never wedges the queue", async () => {
    // Idle auto-stop is out of scope: the orb is deliberately kept in `running`
    // with an undeliverable message, and an idle stop mid-scenario would end
    // the very loop under test for an unrelated and correct reason.
    await runDst({ name: "message-rejected-non-retryable", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const rejectedId = "00000000-0000-4000-8000-000000000126";
      const followUpId = "00000000-0000-4000-8000-000000000127";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            // A 400 the runtime will give again for the same payload: no
            // number of redeliveries can turn this batch into a delivery.
            harness.world.scriptDeliverMessage(ORB, {
              kind: "reject",
              code: "http_error",
              message: "400 invalid_request: message payload too large",
              retryable: false,
            });
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: rejectedId,
              content: [{ type: "text", text: "a payload the runtime refuses" }],
              now: task.wallNow(),
            });
            expect(queued.isOk()).toBe(true);
            // The queue's terminal state exists in the schema for exactly this:
            // the message is failed with the runtime's reason, so the user is
            // told rather than left watching a message that never arrives.
            await waitUntil(
              task,
              "the rejected message is marked failed with the runtime's error",
              () => {
                const message = harness.store.messageSnapshots(ORB)[0];
                return message?.status === "failed" && message.lastError !== null;
              },
              { timeoutMs: 120_000 },
            );
            // And the inbox is not wedged behind the doomed batch: the next
            // message the user sends still reaches the runtime.
            harness.world.scriptDeliverMessage(ORB, { kind: "ok" });
            const followUp = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: followUpId,
              content: [{ type: "text", text: "try this instead" }],
              now: task.wallNow(),
            });
            expect(followUp.isOk()).toBe(true);
            await waitUntil(
              task,
              "the follow-up message is delivered",
              () =>
                harness.store
                  .messageSnapshots(ORB)
                  .find((message) => message.messageId === followUpId)?.status === "delivered",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const rejected = harness.store.messageSnapshots(ORB)[0];
      expect(rejected?.status).toBe("failed");
      expect(rejected?.lastError).toContain("invalid_request");
      // The doomed payload never reached the session, the follow-up did.
      const records = harness.store.replicaRecords(ORB);
      expect(inboxRecordsFor(records, rejectedId)).toHaveLength(0);
      expect(inboxRecordsFor(records, followUpId)).toHaveLength(1);
    });
  });

  it("a queued message never starves the unreachable-runtime restart", async () => {
    // Idle auto-stop is out of scope for the same reason as in the neighbouring
    // restart scenarios: recovery costs a full modeled boot.
    await runDst({ name: "pending-message-blocks-liveness", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000128";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "please continue" }],
              now: task.wallNow(),
            });
            expect(queued.isOk()).toBe(true);
            const firstInstance = harness.world.runtimeInstanceIdOf(ORB);
            // The runtime stops answering while the message is queued: the
            // delivery hangs until its own deadline and the history pulls go
            // silent, while the host keeps observing `running` — the exact
            // shape `unreachable-restart` recovers from with an empty queue.
            harness.world.scriptDeliverMessage(ORB, { kind: "hang", durationMs: 10 * 60_000 });
            harness.world.killRuntimeProcess(ORB);
            await waitUntil(
              task,
              "the unreachable runtime is restarted despite the queued message",
              () => {
                const instance = harness.world.runtimeInstanceIdOf(ORB);
                return instance !== null && instance !== firstInstance;
              },
              { timeoutMs: 300_000 },
            );
            // Recovery is not a state label: the message the user sent is
            // delivered once the restarted runtime answers again.
            harness.world.scriptDeliverMessage(ORB, { kind: "ok" });
            await waitUntil(
              task,
              "the queued message is delivered after the restart",
              () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.messageSnapshots(ORB)[0]?.status).toBe("delivered");
      expect(inboxRecordsFor(harness.store.replicaRecords(ORB), messageId)).toHaveLength(1);
    });
  });

  it("a wake message queued behind an older one still starts the stopped orb", async () => {
    await runDst({ name: "backstop-honors-any-wake-message", iterations: 10 }, async (sim) => {
      // Idle auto-stop is out of scope: the restarted orb pays a full modeled
      // boot before it can deliver, which the test idle window predates.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const olderId = "00000000-0000-4000-8000-000000000129";
      const wakeId = "00000000-0000-4000-8000-000000000130";
      let queuedBoth = false;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            // Held until both messages are durable and the orb is already
            // `stopping`: the older message can then never be claimed while
            // running, so the backstop's decision is a fact of the scenario
            // rather than a race.
            await waitUntil(task, "both messages queued", () => queuedBoth);
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            // Queued while running: no wake intent, the orb is already up.
            const older = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: olderId,
              content: [{ type: "text", text: "look at the failing test" }],
              now: task.wallNow(),
            });
            expect(older.isOk() && older.value.message.autoStart).toBe(false);
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk()).toBe(true);
            // Queued while stopping: this one *is* a wake request, and it is
            // not the oldest outstanding message.
            const wake = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: wakeId,
              content: [{ type: "text", text: "and then open a PR" }],
              now: task.wallNow(),
            });
            expect(wake.isOk() && wake.value.message.autoStart).toBe(true);
            queuedBoth = true;
            await waitUntil(
              task,
              "the stop completes",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            await waitUntil(
              task,
              "the wake message starts the orb again",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 600_000 },
            );
            await waitUntil(
              task,
              "both queued messages are delivered in FIFO order",
              () => {
                const messages = harness.store.messageSnapshots(ORB);
                return messages[0]?.status === "delivered" && messages[1]?.status === "delivered";
              },
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const records = harness.store.replicaRecords(ORB);
      expect(inboxRecordsFor(records, olderId)).toHaveLength(1);
      expect(inboxRecordsFor(records, wakeId)).toHaveLength(1);
      // FIFO: the older message is never delivered after the newer one.
      const olderIndex = records.findIndex((record) => inboxMessageIdsOf(record).includes(olderId));
      const wakeIndex = records.findIndex((record) => inboxMessageIdsOf(record).includes(wakeId));
      expect(olderIndex).toBeLessThanOrEqual(wakeIndex);
    });
  });

  it("a message sent to a failed orb starts it and is delivered", async () => {
    // The product contract the raw-SQL transition in `enqueueOrbMessage` used
    // to carry (removed 2026-08-11): a user who sends into a failed orb is
    // asking for it back, and the wake now runs through the same backstop CAS
    // as every other message-driven start.
    await runDst({ name: "failed-orb-send-wakes", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000140";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initDurationMs: 0 });
            harness.store.seedProject(makeProjectRow(PROJECT));
            harness.store.seedOrb(
              makeOrbRow(ORB, PROJECT, "failed", {
                lastError: "provider_failed: the host never booted",
                stateChangedAt: task.wallNow(),
              }),
            );
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "please try again" }],
              now: task.wallNow(),
            });
            // The intent names the failure the user saw; admission itself
            // leaves the orb failed.
            expect(queued.isOk() && queued.value.orb.state).toBe("failed");
            expect(queued.isOk() && queued.value.message.autoStart).toBe(true);
            expect(queued.isOk() && queued.value.message.wakeStateVersion).toBe(
              queued.isOk() ? queued.value.orb.stateVersion : -1,
            );
            await waitUntil(
              task,
              "the failed orb is started by the queued message",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 600_000 },
            );
            await waitUntil(
              task,
              "the queued message is delivered",
              () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const orb = harness.store.orbSnapshot(ORB);
      expect(orb?.state).toBe("running");
      // The start cleared the failure the user was looking at.
      expect(orb?.lastError).toBeNull();
      expect(inboxRecordsFor(harness.store.replicaRecords(ORB), messageId)).toHaveLength(1);
    });
  });

  it("persists a discard error separately, then recovers exactly once", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "failed-discard-error-recovery", iterations: 30, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        let sawDurableError = false;
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const running = harness.store.orbSnapshot(ORB);
              expect(running).not.toBeNull();
              if (running === null) return;
              harness.world.failNextComputeDiscards(1);
              const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
                orbId: ORB,
                expectedStateVersion: running.stateVersion,
                now: task.wallNow(),
                lastError: "runtime_failed: original failure",
              });
              expect(failed.isOk()).toBe(true);
              await waitUntil(
                task,
                "discard error persisted",
                () => harness.store.orbSnapshot(ORB)?.hostDiscardError !== null,
              );
              sawDurableError = true;
              expect(harness.store.orbSnapshot(ORB)?.lastError).toBe(
                "runtime_failed: original failure",
              );
              await waitUntil(
                task,
                "discard recovered",
                () => harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null,
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(sawDurableError).toBe(true);
        // A legal late provider deadline may add a distinct cancellation edge;
        // the scripted persisting condition itself is emitted only once.
        expect(
          capture
            .matching("compute-discard ")
            .filter(
              (line) =>
                line.includes("outcome=error") && line.includes("scripted compute discard failure"),
            ),
        ).toHaveLength(1);
        expect(capture.matching("compute-discard-recovered")).toHaveLength(1);
        expect(harness.store.orbSnapshot(ORB)?.lastError).toBe("runtime_failed: original failure");
      },
    );
  });

  it("retries safely after restart when compute is absent but finalization failed", async () => {
    await runDst({ name: "discard-finalization-after-delete", iterations: 30 }, async (sim) => {
      let harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const running = harness.store.orbSnapshot(ORB);
            expect(running).not.toBeNull();
            if (running === null) return;
            const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              now: task.wallNow(),
              lastError: "runtime_failed: original failure",
            });
            expect(failed.isOk()).toBe(true);
            harness.store.failNextHostDiscardFinalizations(1);

            let sawAbsentPendingFinalize = false;
            for (let attempt = 0; attempt < 20; attempt++) {
              await reconcileOrbOnce(task, harness.deps, ORB);
              const row = harness.store.orbSnapshot(ORB);
              if (harness.world.hostCount(ORB) === 0 && row?.hostDiscardThroughIncarnation === 0) {
                sawAbsentPendingFinalize = true;
                break;
              }
              await task.sleep(1, "reach discard finalization crash window");
            }
            expect(sawAbsentPendingFinalize).toBe(true);
            expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(0);
            // Process death loses every in-memory condition and operation
            // handle; durable intent plus provider absence are sufficient.
            harness = restartControlPlane(harness);

            for (let attempt = 0; attempt < 20; attempt++) {
              await reconcileOrbOnce(task, harness.deps, ORB);
              if (harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null) {
                break;
              }
              await task.sleep(1, "retry discard finalization");
            }
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              hostDiscardThroughIncarnation: null,
              hostIncarnation: 1,
            });
            expect(harness.world.hostCount(ORB)).toBe(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("two reconcilers dispose idempotently without provisioning replacement", async () => {
    await runDst({ name: "concurrent-failed-disposal", iterations: 50 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "seed",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const running = harness.store.orbSnapshot(ORB);
            expect(running).not.toBeNull();
            if (running === null) return;
            const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              now: task.wallNow(),
              lastError: "runtime_failed: test failure",
            });
            expect(failed.isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);

      const concurrent = await sim.runTasks([
        { name: "reconciler-a", f: (task) => reconcileOrbOnce(task, harness.deps, ORB) },
        { name: "reconciler-b", f: (task) => reconcileOrbOnce(task, harness.deps, ORB) },
      ]);
      expect(concurrent.isOk(), concurrent.isErr() ? concurrent.error.message : "").toBe(true);
      // If a late cancellation left finalization pending, one ordinary pass
      // completes it; no pass is authorized to provision while still failed.
      for (let attempt = 0; attempt < 10; attempt++) {
        if (harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null) break;
        const pass = await sim.runTasks([
          { name: `finalizer-${attempt}`, f: (task) => reconcileOrbOnce(task, harness.deps, ORB) },
        ]);
        expect(pass.isOk(), pass.isErr() ? pass.error.message : "").toBe(true);
      }
      expect(harness.store.orbSnapshot(ORB)).toMatchObject({
        state: "failed",
        hostRef: null,
        hostIncarnation: 1,
        hostDiscardThroughIncarnation: null,
      });
      expect(harness.world.hostCount(ORB)).toBe(0);
      expect(harness.world.hostStartCountOf(ORB)).toBe(1);
    });
  });

  it("Stop racing failed-compute disposal finishes cleanup and converges stopped", async () => {
    await runDst({ name: "stop-during-failed-disposal", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const stopLoop = new AbortController();
      let stopRequested = false;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            while (!stopRequested) await task.sleep(1, "wait for stop during disposal");
            await reconcileLoop(task, harness.deps, stopLoop.signal);
          },
        },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const running = harness.store.orbSnapshot(ORB);
            expect(running).not.toBeNull();
            if (running === null) return;
            const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              now: task.wallNow(),
              lastError: "runtime_failed: test failure",
            });
            expect(failed.isOk()).toBe(true);
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk() && stopped.value).toMatchObject({
              state: "stopping",
              hostDiscardThroughIncarnation: 0,
            });
            stopRequested = true;
            await waitUntil(
              task,
              "stop converged after required discard",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
            );
            stopLoop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)).toMatchObject({
        state: "stopped",
        hostRef: null,
        hostIncarnation: 1,
        hostDiscardThroughIncarnation: null,
      });
      expect(harness.world.hostCount(ORB)).toBe(0);
      expect(harness.world.filesystemExists(ORB)).toBe(true);
    });
  });

  it("explicit Start admitted during failed disposal cannot provision before finalization", async () => {
    await runDst({ name: "failed-explicit-start-during-disposal", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB, { initDurationMs: 0 });
            const running = harness.store.orbSnapshot(ORB);
            expect(running).not.toBeNull();
            if (running === null) return;
            const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
              orbId: ORB,
              expectedStateVersion: running.stateVersion,
              now: task.wallNow(),
              lastError: "runtime_failed: test failure",
              evidence: "container_status=exited exit_code=42",
            });
            expect(failed.isOk()).toBe(true);

            const started = await requestOrbStart(task, harness.deps, ORB);
            expect(started.isOk()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "starting",
              hostDiscardThroughIncarnation: 0,
              hostIncarnation: 0,
            });
            expect(harness.world.hostCount(ORB)).toBe(1);

            for (let attempt = 0; attempt < 100; attempt++) {
              await reconcileOrbOnce(task, harness.deps, ORB);
              if (harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null) break;
              // A modeled provider/store outage is allowed; the fence must
              // remain authoritative until an ordinary retry succeeds.
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "starting",
                hostDiscardThroughIncarnation: 0,
                hostIncarnation: 0,
              });
              await task.sleep(100, "retry explicit-start disposal");
            }
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "starting",
              hostDiscardThroughIncarnation: null,
              hostIncarnation: 1,
              hostRef: null,
            });
            expect(harness.world.hostCount(ORB)).toBe(0);

            for (let attempt = 0; attempt < 2_000; attempt++) {
              await reconcileOrbOnce(task, harness.deps, ORB);
              if (harness.store.orbSnapshot(ORB)?.state === "running") return;
              await task.sleep(100, "wait for explicit replacement readiness");
            }
            expect.fail("explicit replacement did not become running");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(1);
      expect(harness.world.hostCount(ORB)).toBe(1);
      // One original boot plus exactly one user-authorized replacement boot.
      expect(harness.world.hostStartCountOf(ORB)).toBe(2);
    });
  });

  it("a failed-orb wake admitted while disposal is pending survives finalization", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "failed-wake-during-disposal", iterations: 30, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        const messageId = "00000000-0000-4000-8000-000000000143";
        let intentReady = false;
        const result = await sim.runTasks([
          {
            name: "reconciler",
            f: async (task) => {
              while (!intentReady) {
                await task.sleep(1, "wait for failed wake and discard intent");
              }
              await reconcileLoop(task, harness.deps, stop.signal);
            },
          },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB, { initDurationMs: 0 });
              const running = harness.store.orbSnapshot(ORB);
              expect(running).not.toBeNull();
              if (running === null) return;
              const failed = await harness.store.failOrbAndRequestComputeDiscard(task, {
                orbId: ORB,
                expectedStateVersion: running.stateVersion,
                now: task.wallNow(),
                lastError: "runtime_failed: test failure",
              });
              expect(failed.isOk() && failed.value.hostDiscardThroughIncarnation).toBe(0);
              const queued = await harness.store.enqueueOrbMessage(task, {
                orbId: ORB,
                messageId,
                content: [{ type: "text", text: "retry after cleanup" }],
                now: task.wallNow(),
              });
              expect(queued.isOk() && queued.value.message.wakeStateVersion).toBe(
                failed.isOk() ? failed.value.stateVersion : -1,
              );
              intentReady = true;

              await waitUntil(
                task,
                "wake provisions a clean incarnation",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 600_000 },
              );
              await waitUntil(
                task,
                "wake message delivered once",
                () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(1);
        expect(harness.world.hostCount(ORB)).toBe(1);
        expect(inboxRecordsFor(harness.store.replicaRecords(ORB), messageId)).toHaveLength(1);
        expect(capture.matching("replacement-provisioned")).toHaveLength(1);
      },
    );
  });

  it("a boot that fails again is never retried by the intent that woke it", async () => {
    // The other half of the same rule: the wake is one-shot per failure, so a
    // permanent boot failure plus a standing intent cannot become an unbounded
    // provision loop. Only a *new* send buys another attempt.
    const capture = new LogCapture();
    await runDst(
      { name: "failed-orb-wake-is-one-shot", iterations: 8, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        const firstId = "00000000-0000-4000-8000-000000000141";
        const secondId = "00000000-0000-4000-8000-000000000142";
        const wakes = (): number => capture.matching("to=starting reason=queued_message").length;
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              // A host whose runtime always reports a terminal failure: every
              // start attempt ends in `failed` again.
              harness.world.configureOrb(ORB, {
                initDurationMs: 0,
                initOutcome: "failed_nonretryable",
              });
              harness.store.seedProject(makeProjectRow(PROJECT));
              harness.store.seedOrb(
                makeOrbRow(ORB, PROJECT, "failed", {
                  lastError: "runtime_failed: session corrupt",
                  hostIncarnation: 1,
                  hostDiscardEvidence: "container_status=exited exit_code=42",
                  stateChangedAt: task.wallNow(),
                }),
              );
              const first = await harness.store.enqueueOrbMessage(task, {
                orbId: ORB,
                messageId: firstId,
                content: [{ type: "text", text: "come back please" }],
                now: task.wallNow(),
              });
              expect(first.isOk() && first.value.message.autoStart).toBe(true);
              await waitUntil(task, "the send wakes the failed orb once", () => wakes() === 1, {
                timeoutMs: 600_000,
              });
              await waitUntil(
                task,
                "the retried boot fails again",
                () => harness.store.orbSnapshot(ORB)?.state === "failed",
                { timeoutMs: 600_000 },
              );
              // The intent is still outstanding and still carries `auto_start`;
              // what retires it is the version bump the wake performed.
              expect(harness.store.messageSnapshots(ORB)[0]?.autoStart).toBe(true);
              expect(harness.store.messageSnapshots(ORB)[0]?.status).toBe("queued");
              for (let round = 0; round < 10; round++) {
                await task.sleep(
                  TEST_CONSTANTS.hostBackstopIntervalMs,
                  "watching the terminally failed orb",
                );
                expect(harness.store.orbSnapshot(ORB)?.state).toBe("failed");
                expect(wakes()).toBe(1);
              }
              // A new send is new user intent against the failure now on
              // screen, and gets exactly one further attempt.
              const second = await harness.store.enqueueOrbMessage(task, {
                orbId: ORB,
                messageId: secondId,
                content: [{ type: "text", text: "one more time" }],
                now: task.wallNow(),
              });
              expect(second.isOk() && second.value.message.autoStart).toBe(true);
              await waitUntil(task, "the new send wakes the orb again", () => wakes() === 2, {
                timeoutMs: 600_000,
              });
              await waitUntil(
                task,
                "the second authorized boot fails and is disposed",
                () => {
                  const row = harness.store.orbSnapshot(ORB);
                  return (
                    row?.state === "failed" &&
                    row.hostIncarnation === 3 &&
                    row.hostDiscardThroughIncarnation === null
                  );
                },
                { timeoutMs: 600_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(wakes()).toBe(2);
        expect(capture.matching("replacement-provisioned")).toHaveLength(2);
        expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(3);
        expect(harness.world.hostCount(ORB)).toBe(0);
      },
    );
  });

  it("an explicit stop is final even when a message's wake intent was stranded", async () => {
    await runDst({ name: "stale-wake-intent-resurrection", iterations: 8 }, async (sim) => {
      // Idle auto-stop is out of scope: the scenario drives every stop itself,
      // and the assertion is about the absence of a *self*-restart.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000131";
      // The store blip that strands the wake intent: the backstop's clear
      // fails once, after it has already moved the orb out of `stopped`.
      harness.store.failNextClearOrbMessageAutoStart(1);
      let queued = false;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            await waitUntil(task, "wake message queued", () => queued);
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            // Delivery never completes — a legitimate retryable condition —
            // so nothing else clears the wake intent along the way.
            harness.world.scriptDeliverMessage(ORB, { kind: "hang", durationMs: 10 * 60_000 });
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk()).toBe(true);
            const wake = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "wake up and continue" }],
              now: task.wallNow(),
            });
            expect(wake.isOk() && wake.value.message.autoStart).toBe(true);
            queued = true;
            await waitUntil(
              task,
              "the wake message starts the orb again",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 600_000 },
            );
            expect(harness.store.messageSnapshots(ORB)[0]?.autoStart).toBe(true);
            // The user changes their mind and stops the orb explicitly. An
            // explicit stop is the strongest intent the product has: it must
            // outrank a wake intent recorded before it, however that intent
            // came to survive.
            const requested = await requestOrbStop(task, harness.deps, ORB);
            expect(requested.isOk()).toBe(true);
            await waitUntil(
              task,
              "the explicit stop completes",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 600_000 },
            );
            // ...and stays stopped: several backstop passes with no restart.
            for (let round = 0; round < 10; round++) {
              await task.sleep(
                TEST_CONSTANTS.hostBackstopIntervalMs,
                "watching the explicitly stopped orb",
              );
              expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
            }
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
      expect(harness.world.hostStateOf(ORB)).toBe("stopped");
    });
  });

  it("stopping an already-stopped orb succeeds while the wake-intent clear fails", async () => {
    await runDst(
      {
        name: "stop-idempotent-under-store-blip",
        iterations: 10,
        failpointProbabilities: { [FAILPOINTS.storeClearMessageAutoStart]: 1 },
      },
      async (sim) => {
        const harness = makeHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              harness.store.seedProject(makeProjectRow(PROJECT));
              harness.store.seedOrb(makeOrbRow(ORB, PROJECT, "stopped"));
              // Stopping a stopped orb is a no-op the UI issues freely; a
              // bookkeeping write that fails underneath it must not turn that
              // no-op into a 503.
              const requested = await requestOrbStop(task, harness.deps, ORB);
              expect(
                requested.isOk(),
                requested.isErr()
                  ? `${requested.error.code}: ${requested.error.message}`
                  : "stop succeeded",
              ).toBe(true);
              expect(requested.isOk() && requested.value.state).toBe("stopped");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
      },
    );
  });

  it("a delivery note that loses the race to replication still records the delivery", async () => {
    // Replication overtaking the note is a real schedule (~1 in 20 000 free
    // running, found 2026-08-10): the pull commits the inbox record and marks
    // the rows delivered while the note is still in flight. Probability is no
    // way to test it, so the note is held until the record is committed — the
    // exact losing order, every run.
    await runDst({ name: "note-after-replication-commit", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000132";
      let deliveredBeforeNote = false;
      harness.store.holdNextNoteOrbMessageDelivery(() => {
        const replicated = inboxRecordsFor(harness.store.replicaRecords(ORB), messageId).length > 0;
        if (replicated) {
          deliveredBeforeNote = harness.store.messageSnapshots(ORB)[0]?.status === "delivered";
        }
        return replicated;
      });
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "how was this delivered?" }],
              now: task.wallNow(),
            });
            expect(queued.isOk()).toBe(true);
            await waitUntil(
              task,
              "the delivery classification lands on the already-delivered message",
              () => {
                const message = harness.store.messageSnapshots(ORB)[0];
                return message?.status === "delivered" && message.delivery !== null;
              },
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // The note really did arrive second, and its metadata still stuck.
      expect(deliveredBeforeNote).toBe(true);
      const message = harness.store.messageSnapshots(ORB)[0];
      expect(message?.status).toBe("delivered");
      expect(message?.delivery).toBe("turn");
      expect(message?.operationId).not.toBeNull();
      expect(inboxRecordsFor(harness.store.replicaRecords(ORB), messageId)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------
  // The exactly-once crash windows of docs/runtime-protocol.md. PostgreSQL is
  // authoritative before delivery and the session file after it, and no finite
  // acknowledgement can commit both; each scenario below forces one of the
  // windows between them deterministically (a scripted partial delivery, a
  // held reconciler) and asserts the same invariants: exactly one replicated
  // record per delivered batch, every message ID marked delivered exactly
  // once, nothing lost, FIFO preserved, and no second turn started.

  it("a runtime that dies before enqueueing the batch redelivers it exactly once", async () => {
    await runDst({ name: "delivery-crash-before-pi-enqueue", iterations: 10 }, async (sim) => {
      // Idle auto-stop is out of scope: the scenario is about redelivery, and
      // an idle stop mid-flight would end the loop under test.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const messageId = "00000000-0000-4000-8000-000000000143";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const firstInstance = harness.world.runtimeInstanceIdOf(ORB);
            // Scripted before the message exists, so the *first* delivery
            // attempt is the one that dies: the window is a fact of the
            // scenario rather than something to hope for.
            harness.world.scriptDeliverMessage(ORB, { kind: "crash_before_enqueue" });
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId,
              content: [{ type: "text", text: "did this survive?" }],
              now: task.wallNow(),
            });
            expect(queued.isOk()).toBe(true);
            await waitUntil(
              task,
              "the incarnation that took the delivery is gone",
              () => {
                const instance = harness.world.runtimeInstanceIdOf(ORB);
                return instance !== null && instance !== firstInstance;
              },
              { timeoutMs: 120_000 },
            );
            // Nothing of the batch survived the crash: not in memory, not on
            // disk. Redelivery is therefore the only way the user's message
            // can arrive at all.
            expect(harness.world.pendingInboxBatchesOf(ORB)).toEqual([]);
            expect(
              harness.world.entriesOf(ORB).filter((record) => inboxMessageIdsOf(record).length > 0),
            ).toHaveLength(0);
            await waitUntil(
              task,
              "the lost batch is redelivered and replicated",
              () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
              { timeoutMs: 300_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertInboxDeliveredExactlyOnce(harness, ORB, [messageId]);
    });
  });

  it("a batch lost before the session write is redelivered, and a retry before it is not", async () => {
    await runDst(
      { name: "delivery-crash-after-enqueue-before-persist", iterations: 10 },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        const messageId = "00000000-0000-4000-8000-000000000144";
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              // Accepted into Pi and answered, but not written to the session:
              // the window in which the runtime's in-memory pending set is the
              // only thing that knows about this batch.
              harness.world.scriptDeliverMessage(ORB, { kind: "enqueue_without_persist" });
              const queued = await harness.store.enqueueOrbMessage(task, {
                orbId: ORB,
                messageId,
                content: [{ type: "text", text: "half-delivered" }],
                now: task.wallNow(),
              });
              expect(queued.isOk()).toBe(true);
              await waitUntil(
                task,
                "the runtime holds the batch pending",
                () => harness.world.pendingInboxBatchesOf(ORB).includes(messageId),
                { timeoutMs: 120_000 },
              );
              // The batch stays claimed, so the reconciler redelivers it every
              // pass. Those retries must find it pending and do nothing —
              // otherwise one queued message becomes several agent turns.
              await task.sleep(
                6 * TEST_CONSTANTS.reconcileTickMs,
                "let the control plane retry the still-claimed batch",
              );
              expect(harness.world.pendingInboxBatchesOf(ORB)).toEqual([messageId]);
              expect(harness.store.messageSnapshots(ORB)[0]?.status).toBe("delivering");
              // Now the process dies with the batch still only in memory.
              harness.world.restartRuntimeProcess(task, ORB);
              expect(harness.world.pendingInboxBatchesOf(ORB)).toEqual([]);
              harness.world.scriptDeliverMessage(ORB, { kind: "ok" });
              await waitUntil(
                task,
                "the lost batch is redelivered and replicated",
                () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertInboxDeliveredExactlyOnce(harness, ORB, [messageId]);
      },
    );
  });

  it("a persisted batch whose acknowledgement is lost is never delivered twice", async () => {
    await runDst(
      { name: "delivery-crash-after-persist-before-ack", iterations: 10 },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        const messageId = "00000000-0000-4000-8000-000000000145";
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              // Durable in the session, and every answer lost: the control
              // plane can only learn of this delivery through replication.
              harness.world.scriptDeliverMessage(ORB, { kind: "persist_without_ack" });
              const queued = await harness.store.enqueueOrbMessage(task, {
                orbId: ORB,
                messageId,
                content: [{ type: "text", text: "the ack will be lost" }],
                now: task.wallNow(),
              });
              expect(queued.isOk()).toBe(true);
              await waitUntil(
                task,
                "replication marks the message delivered without any acknowledgement",
                () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
                { timeoutMs: 300_000 },
              );
              // ...and the retries the control plane made in the meantime,
              // every one of them answered with a lost ack, produced no second
              // record and no second turn.
              await task.sleep(
                6 * TEST_CONSTANTS.reconcileTickMs,
                "watch for a redelivery after the record is durable",
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertInboxDeliveredExactlyOnce(harness, ORB, [messageId]);
        // The classification is the acknowledgement's payload alone, so a
        // permanently lost ack loses it: the message is still delivered, it
        // just cannot say how (docs/runtime-protocol.md).
        const message = harness.store.messageSnapshots(ORB)[0];
        expect(message?.delivery).toBeNull();
      },
    );
  });

  it("two control-plane dispatchers deliver one batch exactly once", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "two-dispatchers-one-delivery", iterations: 15, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        // A second control-plane process: same database and same fleet, its own
        // in-process memory (docs/testing.md — version skew and rollovers put
        // two of these on the same orb routinely).
        const second: ControlPlaneDeps = { ...harness.deps, control: new ControlState() };
        const stop = new AbortController();
        const firstId = "00000000-0000-4000-8000-000000000146";
        const secondId = "00000000-0000-4000-8000-000000000147";
        let bothQueued = false;
        const result = await sim.runTasks([
          {
            name: "dispatcher-1",
            f: async (task) => {
              await waitUntil(task, "both messages queued", () => bothQueued);
              await reconcileLoop(task, harness.deps, stop.signal);
            },
          },
          {
            name: "dispatcher-2",
            f: async (task) => {
              await waitUntil(task, "both messages queued", () => bothQueued);
              await reconcileLoop(task, second, stop.signal);
            },
          },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              for (const messageId of [firstId, secondId]) {
                const queued = await harness.store.enqueueOrbMessage(task, {
                  orbId: ORB,
                  messageId,
                  content: [{ type: "text", text: `work item ${messageId.slice(-3)}` }],
                  now: task.wallNow(),
                });
                expect(queued.isOk()).toBe(true);
              }
              bothQueued = true;
              await waitUntil(
                task,
                "both messages are delivered",
                () =>
                  harness.store
                    .messageSnapshots(ORB)
                    .every((message) => message.status === "delivered"),
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertInboxDeliveredExactlyOnce(harness, ORB, [firstId, secondId]);
        // Both dispatchers may call the runtime; exactly one call can be the
        // one that enqueues, and only that one logs a dispatch.
        expect(capture.matching("message-batch-dispatched")).toHaveLength(1);
      },
    );
  });

  it("an explicit stop outranks a queued message, and a later send starts the orb", async () => {
    await runDst({ name: "send-versus-stop", iterations: 10 }, async (sim) => {
      // Idle auto-stop is out of scope: every stop here is explicit and the
      // restart pays a full modeled boot.
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const beforeStopId = "00000000-0000-4000-8000-000000000148";
      const afterStopId = "00000000-0000-4000-8000-000000000149";
      let stopRequested = false;
      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            // Held until the stop is durable, so the message can never be
            // delivered before it: this scenario is about the ordering, not
            // about which side of the race won.
            await waitUntil(task, "the stop is requested", () => stopRequested);
            await reconcileLoop(task, harness.deps, stop.signal);
          },
        },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const queued = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: beforeStopId,
              content: [{ type: "text", text: "queued while running" }],
              now: task.wallNow(),
            });
            // Admitted while running: the orb is up, so no wake is recorded.
            expect(queued.isOk() && queued.value.message.autoStart).toBe(false);
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk()).toBe(true);
            stopRequested = true;
            await waitUntil(
              task,
              "the stop completes",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            // The message is neither delivered nor discarded, and it does not
            // resurrect the orb the user just stopped.
            expect(harness.store.messageSnapshots(ORB)[0]?.status).toBe("queued");
            expect(harness.store.messageSnapshots(ORB)[0]?.autoStart).toBe(false);
            for (let round = 0; round < 6; round++) {
              await task.sleep(
                TEST_CONSTANTS.hostBackstopIntervalMs,
                "watching the explicitly stopped orb",
              );
              expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
            }
            // A send linearized after the stop is new intent: it starts the
            // orb, and the message that was waiting goes first.
            const wake = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: afterStopId,
              content: [{ type: "text", text: "queued after the stop" }],
              now: task.wallNow(),
            });
            expect(wake.isOk() && wake.value.message.autoStart).toBe(true);
            await waitUntil(
              task,
              "both messages are delivered after the wake",
              () =>
                harness.store
                  .messageSnapshots(ORB)
                  .every((message) => message.status === "delivered"),
              { timeoutMs: 600_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertInboxDeliveredExactlyOnce(harness, ORB, [beforeStopId, afterStopId]);
      assertInboxFifo(harness, ORB, [beforeStopId, afterStopId]);
    });
  });

  it("messages queued across a runtime boot are delivered once, in FIFO order", async () => {
    await runDst({ name: "fifo-across-runtime-boot", iterations: 10 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const beforeBootId = "00000000-0000-4000-8000-000000000150";
      const afterBootId = "00000000-0000-4000-8000-000000000151";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const first = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: beforeBootId,
              content: [{ type: "text", text: "before the boot" }],
              now: task.wallNow(),
            });
            expect(first.isOk()).toBe(true);
            await waitUntil(
              task,
              "the first message is delivered and replicated",
              () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
              { timeoutMs: 300_000 },
            );
            // The agent finishes that turn, so the session tail is settled and
            // the boot below has nothing to resume.
            harness.world.finishTurn(ORB);
            const stopped = await requestOrbStop(task, harness.deps, ORB);
            expect(stopped.isOk()).toBe(true);
            await waitUntil(
              task,
              "the orb stops",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 300_000 },
            );
            const second = await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: afterBootId,
              content: [{ type: "text", text: "after the boot" }],
              now: task.wallNow(),
            });
            expect(second.isOk() && second.value.message.autoStart).toBe(true);
            await waitUntil(
              task,
              "the second message is delivered on the rebooted runtime",
              () =>
                harness.store.messageSnapshots(ORB).find((m) => m.messageId === afterBootId)
                  ?.status === "delivered",
              { timeoutMs: 600_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      // The already-delivered message is not re-sent to the rebooted runtime,
      // and the new one lands behind it.
      assertInboxDeliveredExactlyOnce(harness, ORB, [beforeBootId, afterBootId]);
      assertInboxFifo(harness, ORB, [beforeBootId, afterBootId]);
      // A settled tail is not an interrupted turn: the boot resumed nothing,
      // so the delivered message started exactly one turn.
      expect(harness.world.resumeMarkersOf(ORB)).toHaveLength(0);
      assertReplicaComplete(harness.world, harness.store, ORB);
    });
  });

  it("an outstanding message blocks the idle stop until it is delivered", async () => {
    // The invariant is about the *idle* stop specifically, so it is asserted
    // on the idle transition itself rather than on host stops: an unreachable
    // restart is a legitimate, differently-motivated stop that the scheduler
    // can provoke at any time by starving the poller, and forbidding it here
    // would make this scenario flaky for a reason it does not test.
    const capture = new LogCapture();
    await runDst(
      { name: "idle-stop-versus-send", iterations: 10, logCapture: capture },
      async (sim) => {
        // The default (test) idle window, deliberately: this scenario is about
        // the idle deadline actually expiring under an undelivered message.
        const harness = makeHarness();
        const stop = new AbortController();
        const messageId = "00000000-0000-4000-8000-000000000152";
        const idleStops = (): number => capture.matching("stop_reason=idle").length;
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              // One flushed record so the long idle stretch cannot evaporate the
              // session identity (docs/history-replication.md).
              harness.world.appendMessage(ORB);
              // The delivery never answers, so the batch stays outstanding for
              // as long as the scenario wants: the idle deadline is guaranteed
              // to expire while user work is in flight.
              harness.world.scriptDeliverMessage(ORB, {
                kind: "hang",
                durationMs: 10 * TEST_CONSTANTS.idleStopAfterMs,
              });
              const queued = await harness.store.enqueueOrbMessage(task, {
                orbId: ORB,
                messageId,
                content: [{ type: "text", text: "work the user is waiting for" }],
                now: task.wallNow(),
              });
              expect(queued.isOk()).toBe(true);
              await sleepInSteps(
                task,
                2 * TEST_CONSTANTS.idleStopAfterMs,
                "let the idle deadline expire under an undelivered message",
              );
              // An undelivered message is user work in flight: the reconciler
              // returns before the idle check while a batch is outstanding, so
              // the expired deadline above must not have stopped anything.
              expect(idleStops()).toBe(0);
              harness.world.scriptDeliverMessage(ORB, { kind: "ok" });
              await waitUntil(
                task,
                "the message is delivered once the runtime answers",
                () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
                { timeoutMs: 600_000 },
              );
              // Still nothing idle-stopped while the user's work was in flight.
              expect(idleStops()).toBe(0);
              // The agent finishes the turn the message started; the countdown
              // resumes from the delivery and the block converges rather than
              // pinning the host up forever.
              harness.world.finishTurn(ORB);
              await waitUntil(
                task,
                "the orb idle-stops once the work is done",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                { timeoutMs: 600_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)?.stopReason).toBe("idle");
        assertInboxDeliveredExactlyOnce(harness, ORB, [messageId]);
        assertReplicaComplete(harness.world, harness.store, ORB);
      },
    );
  });

  it("a retryably failing drain never stops the host until it succeeds", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "drain-blocked-retryable", iterations: 25, logCapture: capture },
      async (sim) => {
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
        // The blocked drain retries every reconcile tick for the whole outage
        // and logs the block on the retrying edge only. The status is cleared
        // in exactly one place — a drain that caught up — so a drain that then
        // has to start over (a failed host stop) opens a new episode and earns
        // one more line. That, and not a bare "at most one", is the invariant.
        expect(capture.matching("drain-blocked").length).toBeLessThanOrEqual(
          capture.matching("drain-caught-up").length + 1,
        );
      },
    );
  });

  it("an integrity failure during drain fails the orb and discards compute", async () => {
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
              "failed compute discarded",
              () =>
                harness.world.hostStateOf(ORB) === null &&
                harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)?.lastError).toContain("replication_integrity");
      expect(harness.store.orbSnapshot(ORB)?.hostIncarnation).toBe(1);
      expect(harness.world.hostStateOf(ORB)).toBeNull();
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
    const capture = new LogCapture();
    await runDst(
      { name: "preemption-while-running", iterations: 15, logCapture: capture },
      async (sim) => {
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
        let totalStops = 0;
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
              totalStops = harness.world.hostStopCountOf(ORB);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
        assertReplicaComplete(harness.world, harness.store, ORB);
        assertAtMostOneHost(harness.world, ORB);
        // The recovery is legible from the log alone: whichever path won the
        // race (liveness grace expiry or the host observing `stopped` after its
        // ACPI window), the orb left `running` through `starting`...
        expect(
          capture.matching("transition from=running to=starting").length,
        ).toBeGreaterThanOrEqual(1);
        // ...and no host stop happened without a line explaining it. (Logged
        // stops can exceed provider-applied ones: a cancelled stop still
        // records the decision.)
        expect(capture.matching(" host-stop ").length).toBeGreaterThanOrEqual(totalStops);
        for (const line of capture.matching(" host-stop ")) expect(line).toContain("reason=");
      },
    );
  });

  // The compounding failure of docs/postmortems/2026-08-07-preemption-lost-turn.md,
  // from the control plane's side: recovery worked (96s, no storm), but the
  // runtime came back idle with a truncated turn and the idle reaper — working
  // exactly as designed against a genuinely idle orb — collected it 15 minutes
  // later. With the runtime's interrupted-turn resume (docs/lifecycle.md,
  // decided 2026-08-07) the recovered runtime is busy again, so the reaper
  // never fires. This scenario therefore runs on the DEFAULT idle window,
  // unlike its restart-cluster neighbours: *not* idle-stopping the resumed orb
  // is the property under test, and opting out would erase it.
  it("a preemption mid-turn resumes the turn and the orb is never idle-stopped", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "preemption-mid-turn-resumes", iterations: 15, logCapture: capture },
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
              // Keep setup's unrelated idle timer out until the first busy
              // pull is durable; adversarial late timers may otherwise let the
              // reaper beat the poll that establishes this scenario's premise.
              harness.deps.control.registerBrowserConnection(ORB, "setup-tab");
              harness.deps.control.setBrowserVisibility(ORB, "setup-tab", true, task.wallNow());
              // A turn in flight: its user message is flushed and the runtime
              // is busy working on it.
              harness.world.beginTurn(ORB);
              await waitUntil(
                task,
                "the turn is replicated and observed busy",
                () =>
                  harness.store.replicaRecords(ORB).length === 1 &&
                  harness.store.orbSnapshot(ORB)?.lastBusyAt !== null,
              );
              harness.deps.control.unregisterBrowserConnection(ORB, "setup-tab", task.wallNow());
              const busyBeforePreemption = harness.store.orbSnapshot(ORB)?.lastBusyAt ?? 0;
              const stopsBefore = harness.world.hostStopCountOf(ORB);
              // The Spot preemption, mid-turn.
              harness.world.preemptHost(task, ORB);
              await waitUntil(
                task,
                "orb running on a serving runtime again",
                () =>
                  harness.store.orbSnapshot(ORB)?.state === "running" &&
                  harness.world.isRuntimeServing(task, ORB),
                { timeoutMs: 20 * 60_000 },
              );
              // Whichever path recovered it (silence or observed-stopped), the
              // orb is back at the cost of one restart, not a storm.
              expect(harness.world.hostStopCountOf(ORB) - stopsBefore).toBeLessThanOrEqual(
                MAX_STOPS_PER_RECOVERY,
              );
              // The boot resumed the turn: exactly one marker record, flushed
              // and therefore replicable like any other record.
              const markers = harness.world.resumeMarkersOf(ORB);
              expect(markers.length).toBe(1);
              const markerId = markers[0]?.id;
              await waitUntil(
                task,
                "the resume marker replicates",
                () => harness.store.replicaRecords(ORB).some((record) => record.id === markerId),
                { timeoutMs: 300_000 },
              );
              // The resumed turn is ordinary `busy` activity, so the pulls
              // refresh the idle-stop anchor again.
              await waitUntil(
                task,
                "busy refreshed on the resumed runtime",
                () => (harness.store.orbSnapshot(ORB)?.lastBusyAt ?? 0) > busyBeforePreemption,
                { timeoutMs: 300_000 },
              );
              // Two full default idle windows, watched in pull-sized steps (a
              // single long sleep would let the scheduler leap virtual time
              // past the liveness grace): the orb must never head for a stop.
              // Before resume existed this is where the incident's second half
              // happened — one idle window after the recovery, `idle_for_`.
              const rounds = Math.ceil(
                (2 * TEST_CONSTANTS.idleStopAfterMs) / TEST_CONSTANTS.historyPullIntervalMs,
              );
              for (let round = 0; round < rounds; round++) {
                await task.sleep(TEST_CONSTANTS.historyPullIntervalMs, "watching the resumed orb");
                const state = harness.store.orbSnapshot(ORB)?.state;
                expect(state === "stopping" || state === "stopped").toBe(false);
              }
              // End with a controlled explicit stop rather than aborting the
              // poller against a concurrently appended resume/decline marker.
              // The drain makes replica completeness a valid postcondition;
              // aborting both loops at an arbitrary running edge does not.
              const requested = await requestOrbStop(task, harness.deps, ORB);
              expect(requested.isOk()).toBe(true);
              await waitUntil(
                task,
                "explicit final stop drains resumed history",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // One interruption, one resume — for the whole scenario.
        expect(harness.world.resumeMarkersOf(ORB).length).toBe(1);
        assertReplicaComplete(harness.world, harness.store, ORB);
        assertAtMostOneHost(harness.world, ORB);
        // The recovery is legible from the log, as in the neighbouring
        // preemption scenario...
        expect(
          capture.matching("transition from=running to=starting").length,
        ).toBeGreaterThanOrEqual(1);
        // ...the boot decision is legible from the event log alone: the
        // question "did the interrupted turn come back?" is answered without
        // any guest-log spelunking (docs/lifecycle.md).
        expect(capture.matching("turn-resume outcome=resumed").length).toBeGreaterThanOrEqual(1);
        // ...and the incident's compounding is simply absent: no idle decision
        // was ever taken against the orb whose turn was interrupted.
        expect(capture.matching("reason=idle_for_")).toEqual([]);
        expect(capture.matching("stop_reason=idle")).toEqual([]);
      },
    );
  });

  // The loop guard of the same design: at most one auto-resume per
  // interruption. A turn that dies with its host again after resuming sees
  // marker-then-dangling-tail on the next boot and stays idle — so the orb is
  // genuinely idle and the reaper collects it, which is the designed outcome
  // rather than a regression: resuming forever would burn tokens and VM hours
  // on a turn that kills its host every time.
  it("a turn interrupted again after resuming resumes only once and then idle-stops", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "resume-guard-single-shot", iterations: 12, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const stop = new AbortController();
        let stopsDuringScenario = 0;
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              harness.deps.control.registerBrowserConnection(ORB, "setup-tab");
              harness.deps.control.setBrowserVisibility(ORB, "setup-tab", true, task.wallNow());
              harness.world.beginTurn(ORB);
              await waitUntil(
                task,
                "the turn is replicated",
                () => harness.store.replicaRecords(ORB).length === 1,
              );
              harness.deps.control.unregisterBrowserConnection(ORB, "setup-tab", task.wallNow());
              const stopsBefore = harness.world.hostStopCountOf(ORB);
              harness.world.preemptHost(task, ORB);
              await waitUntil(
                task,
                "orb running on the resumed runtime",
                () =>
                  harness.store.orbSnapshot(ORB)?.state === "running" &&
                  harness.world.isRuntimeServing(task, ORB),
                { timeoutMs: 20 * 60_000 },
              );
              expect(harness.world.resumeMarkersOf(ORB).length).toBe(1);
              const resumedInstance = harness.world.runtimeInstanceIdOf(ORB);
              // The resumed turn kills its host a second time.
              harness.world.preemptHost(task, ORB);
              await waitUntil(
                task,
                "orb running again after the second host death",
                () =>
                  harness.store.orbSnapshot(ORB)?.state === "running" &&
                  harness.world.isRuntimeServing(task, ORB) &&
                  harness.world.runtimeInstanceIdOf(ORB) !== resumedInstance,
                { timeoutMs: 20 * 60_000 },
              );
              // No second resume: the marker in the tail is the guard.
              expect(harness.world.resumeMarkersOf(ORB).length).toBe(1);
              // The orb is now genuinely idle, and the idle auto-stop collects
              // it on the ordinary default window — the designed ending.
              await waitUntil(
                task,
                "the un-resumed orb idle-stops",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                { timeoutMs: 20 * 60_000 },
              );
              stopsDuringScenario = harness.world.hostStopCountOf(ORB) - stopsBefore;
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const orb = harness.store.orbSnapshot(ORB);
        expect(orb?.state).toBe("stopped");
        expect(orb?.stopReason).toBe("idle");
        expect(orb?.lastError).toBeNull();
        // Exactly one marker, on the filesystem and in the replica: the drain
        // barrier carried it across the stop.
        expect(harness.world.resumeMarkersOf(ORB).length).toBe(1);
        expect(harness.store.replicaRecords(ORB).filter(isResumeMarker).length).toBe(1);
        // The guard declined out loud, exactly once for the one interruption
        // it suppressed — and that record replicated like any other, so the
        // user finds it in the history the UI shows them.
        expect(harness.world.declineMarkersOf(ORB).length).toBe(1);
        expect(harness.store.replicaRecords(ORB).filter(isDeclineMarker).length).toBe(1);
        expect(
          capture.matching("turn-resume outcome=declined_already_resumed").length,
        ).toBeGreaterThanOrEqual(1);
        // Two recoveries plus the final idle stop, and nothing beyond that: a
        // turn that keeps dying does not become a restart storm.
        expect(stopsDuringScenario).toBeLessThanOrEqual(2 * MAX_STOPS_PER_RECOVERY);
        assertReplicaComplete(harness.world, harness.store, ORB);
        assertAtMostOneHost(harness.world, ORB);
        // Both host deaths recovered through `starting`, and the ending names
        // itself: one idle decision with its stop_reason.
        expect(
          capture.matching("transition from=running to=starting").length,
        ).toBeGreaterThanOrEqual(2);
        expect(capture.matching("to=stopping reason=idle_for_").length).toBe(1);
        expect(capture.matching("stop_reason=idle").length).toBe(1);
      },
    );
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
    const capture = new LogCapture();
    await runDst(
      { name: "stopping-restart-cap", iterations: 15, logCapture: capture },
      async (sim) => {
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
        // The refusal to restart a second time is the decision an operator needs
        // to see, and it is logged before the drain is failed.
        expect(capture.matching("drain-restart-cap").length).toBe(1);
        expect(capture.matching("to=failed code=drain_runtime_unrecoverable").length).toBe(1);
      },
    );
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
    const capture = new LogCapture();
    await runDst(
      { name: "idle-stop-happy-path", iterations: 20, logCapture: capture },
      async (sim) => {
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
        // An unexplained stop was the worst part of the 2026-08-05 incident: the
        // idle decision names itself and its stop_reason.
        expect(capture.matching("to=stopping reason=idle_for_").length).toBeGreaterThanOrEqual(1);
        expect(capture.matching("stop_reason=idle").length).toBeGreaterThanOrEqual(1);
      },
    );
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
            before.deps.control.registerBrowserConnection(ORB, "setup-tab");
            before.deps.control.setBrowserVisibility(ORB, "setup-tab", true, task.wallNow());
            before.world.setActivity(ORB, "busy");
            await waitUntil(
              task,
              "busy activity persisted",
              () => before.store.orbSnapshot(ORB)?.lastBusyAt !== null,
              { timeoutMs: 60_000 },
            );
            before.deps.control.unregisterBrowserConnection(ORB, "setup-tab", task.wallNow());
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

/**
 * The noise rule of `docs/lifecycle.md`: the reconciler logs edges — state
 * changes, decisions, failures — and never levels. These scenarios drive the
 * reconcile/poll passes by hand instead of through the loops, so the number of
 * passes is exact and the "once per episode, not once per pass" guarantees are
 * assertions rather than estimates.
 */
describe("reconciler logging (DST)", () => {
  /**
   * A late-firing operation deadline is a legal schedule and advances virtual
   * time by a whole provider timeout (found here, 2026-08-06): a hand-driven
   * scenario can therefore leap seconds between passes. Every window that would
   * make the reconciler decide something *else* — a liveness lapse, an idle
   * stop, a drain deadline — is pushed far beyond any such leap, so what these
   * scenarios log stays the property under test rather than a race.
   */
  const QUIET_CONSTANTS = {
    unreachableGraceMs: 12 * 3_600_000,
    postRestartGraceMs: 12 * 3_600_000,
    idleStopAfterMs: 12 * 3_600_000,
    createStartDeadlineMs: 12 * 3_600_000,
  };

  it("a healthy running orb logs nothing at all", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "logging-quiet-steady-state", iterations: 10, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: QUIET_CONSTANTS });
        let caughtUp = 0;
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              harness.world.appendMessage(ORB);
              harness.world.appendMessage(ORB);
              // Full reconcile + pull cycles of an entirely healthy orb,
              // including the batch commit of the two records. A cancelled
              // provider call makes a pass retryable — also a non-event, and
              // also silent.
              for (let pass = 0; pass < 12; pass++) {
                const reconciled = await reconcileOrbOnce(task, harness.deps, ORB);
                expect(["noop", "retryable"]).toContain(reconciled.type);
                const polled = await pollOrbUntilCaughtUp(task, harness.deps, ORB);
                expect(["caught_up", "retryable"]).toContain(polled.type);
                if (polled.type === "caught_up") caughtUp += 1;
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Positive control: healthy work really happened during the silence.
        expect(caughtUp).toBeGreaterThanOrEqual(1);
        expect(harness.store.replicaRecords(ORB).length).toBe(2);
        expect(capture.lines()).toEqual([]);
      },
    );
  });

  it("a drain blocked for many passes logs the block once", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "logging-drain-blocked-edge", iterations: 10, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: QUIET_CONSTANTS });
        let blocked = 0;
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              harness.world.appendMessage(ORB);
              const stopped = await requestOrbStop(task, harness.deps, ORB);
              expect(stopped.isOk()).toBe(true);
              // The history endpoint is down for longer than the scenario can
              // possibly last, so every drain pass blocks and none completes.
              harness.world.setPullOutage(task, ORB, 12 * 3_600_000);
              for (let pass = 0; pass < 8; pass++) {
                const outcome = await reconcileOrbOnce(task, harness.deps, ORB);
                if (outcome.type === "waiting") {
                  expect(outcome.reason).toBe("drain_blocked");
                  blocked += 1;
                } else {
                  // A cancelled provider observation: the drain is equally
                  // stuck, it just never reached the pull.
                  expect(outcome.type).toBe("retryable");
                }
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        // Many blocked passes, one line.
        expect(blocked).toBeGreaterThanOrEqual(2);
        expect(capture.matching("drain-blocked").length).toBe(1);
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopping");
      },
    );
  });

  it("logs discard recovery from durable error state after control-plane restart", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "logging-discard-recovery-after-restart", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: QUIET_CONSTANTS });
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              harness.store.seedProject(makeProjectRow(PROJECT));
              harness.store.seedOrb(
                makeOrbRow(ORB, PROJECT, "failed", {
                  lastError: "runtime_failed: original failure",
                  hostIncarnation: 0,
                  hostDiscardThroughIncarnation: 0,
                  hostDiscardReason: "failed",
                  hostDiscardError: "provider was unavailable",
                  hostDiscardRequestedAt: task.wallNow(),
                }),
              );
              // Fresh ControlState models a restarted process: the only
              // recovery evidence is the persisted discard error.
              const outcome = await reconcileOrbOnce(task, harness.deps, ORB);
              expect(["progressed", "retryable"]).toContain(outcome.type);
              if (outcome.type === "retryable") {
                const retried = await reconcileOrbOnce(task, harness.deps, ORB);
                expect(retried.type).toBe("progressed");
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("compute-discard-recovered").length).toBe(1);
        expect(harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation).toBeNull();
      },
    );
  });

  it("a store outage logs once per outage, not once per tick", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "logging-store-outage-edge",
        iterations: 5,
        logCapture: capture,
        failpointProbabilities: { [FAILPOINTS.storeRead]: 1 },
      },
      async (sim) => {
        const harness = makeHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              for (let tick = 0; tick < 5; tick++) await pollAllOnce(task, harness.deps);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("poll-loop-blind").length).toBe(1);
        expect(capture.matching("poll-loop-recovered").length).toBe(0);
      },
    );
  });
});
