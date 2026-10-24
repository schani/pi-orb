import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  makeRevision,
  seedRunningOnRevisions,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { FakeOrbHostProvider } from "../testkit/world.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type {
  ControlPlaneDeps,
  OperationContext,
  OrbHostRef,
  ProvisionOrbHostRequest,
} from "./ports.ts";

const ORB = "orb-mixed";
const PROJECT = "project-mixed";
const REPOSITORY_URL = makeProjectRow(PROJECT).repositoryUrl;

/**
 * Two desired specifications live in the fleet during a deploy. Replacement
 * may move only from the old generation to the new, never backward.
 */
const OLD_GENERATION = 1;
const NEW_GENERATION = 2;

/**
 * The two revisions deploy different *effective* specifications (production:
 * runtime digest, startup contract, machine settings; here opaque strings),
 * which is what makes their fingerprints differ. The generation is a separate
 * input that only fences who may replace forward, so a redeploy that changes
 * nothing effective still changes no fingerprint and replaces nothing.
 */
const OLD_SPEC = "spec-rollover-old";
const NEW_SPEC = "spec-rollover-new";

class StaleObserveProvider extends FakeOrbHostProvider {
  entered = false;
  finished = false;
  private readonly countHosts: () => number;

  override observe(task: SimulationTask, ref: OrbHostRef, context: OperationContext) {
    this.entered = true;
    return ResultAsync.fromSafePromise(
      (async () => {
        while (this.worldHostCount() > 0) await task.sleep(1, "wait for replacement discard");
      })(),
    ).andThen(() => super.observe(task, ref, context));
  }

  constructor(
    countHosts: () => number,
    ...args: ConstructorParameters<typeof FakeOrbHostProvider>
  ) {
    super(...args);
    this.countHosts = countHosts;
  }

  private worldHostCount(): number {
    return this.countHosts();
  }
}

class WinnerProvisionProvider extends FakeOrbHostProvider {
  private readonly stale: StaleObserveProvider;

  constructor(
    stale: StaleObserveProvider,
    ...args: ConstructorParameters<typeof FakeOrbHostProvider>
  ) {
    super(...args);
    this.stale = stale;
  }

  override provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ) {
    if (request.incarnation === 0) return super.provision(task, request, context);
    return ResultAsync.fromSafePromise(
      (async () => {
        while (!this.stale.finished) await task.sleep(1, "wait for stale absence pass");
      })(),
    ).andThen(() => super.provision(task, request, context));
  }
}

class LateProvisionProvider extends FakeOrbHostProvider {
  provisionEntered = false;
  finished = false;
  private readonly countHosts: () => number;

  constructor(
    countHosts: () => number,
    ...args: ConstructorParameters<typeof FakeOrbHostProvider>
  ) {
    super(...args);
    this.countHosts = countHosts;
  }

  override observe() {
    return ResultAsync.fromSafePromise(Promise.resolve(null));
  }

  override provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ) {
    this.provisionEntered = true;
    return ResultAsync.fromSafePromise(
      (async () => {
        while (this.countHosts() > 0) await task.sleep(1, "wait for stale provider effect");
      })(),
    ).andThen(() => super.provision(task, request, context));
  }
}

class HeldDiscardProvider extends FakeOrbHostProvider {
  private readonly stale: LateProvisionProvider;

  constructor(
    stale: LateProvisionProvider,
    ...args: ConstructorParameters<typeof FakeOrbHostProvider>
  ) {
    super(...args);
    this.stale = stale;
  }

  override discardCompute(
    task: SimulationTask,
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ) {
    return super.discardCompute(task, request, context).andThen(() =>
      ResultAsync.fromSafePromise(
        (async () => {
          while (!this.stale.finished) await task.sleep(1, "hold replacement finalization");
        })(),
      ),
    );
  }
}

/** A user-driven stop/start round trip. */
async function stopStartCycle(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  harness: TestHarness,
  capture: LogCapture,
  cycle: string,
): Promise<void> {
  const stopped = await requestOrbStop(task, deps, ORB);
  expect(stopped.isOk(), stopped.isErr() ? stopped.error.message : "").toBe(true);
  await waitUntil(
    task,
    `${cycle} stop reached a terminal decision`,
    () => {
      const state = harness.store.orbSnapshot(ORB)?.state;
      return state === "stopped" || state === "failed";
    },
    { timeoutMs: 900_000 },
  );
  const stoppedOrb = harness.store.orbSnapshot(ORB);
  expect(
    stoppedOrb?.state,
    `${cycle} stop ended as ${stoppedOrb?.state}: ${stoppedOrb?.lastError ?? "no error"}\n${capture
      .lines()
      .join("\n")}`,
  ).toBe("stopped");
  const started = await requestOrbStart(task, deps, ORB);
  expect(started.isOk(), started.isErr() ? started.error.message : "").toBe(true);
  await waitUntil(
    task,
    "orb running again",
    () => harness.store.orbSnapshot(ORB)?.state === "running",
    { timeoutMs: 900_000 },
  );
}

/**
 * Version skew is part of the model (docs/testing.md, decided 2026-08-06): a
 * deploy briefly runs a heterogeneous fleet, and no reconciler may treat the
 * other revision's expected script as damage. Immutable replacement removes
 * mutation, while the committed generation prevents the old revision from
 * replacing the new revision's compute backward.
 *
 * Falsifiability (mutation testing; re-verify by mutating, running, and
 * reverting — never leave a mutation behind):
 *
 * - disabling the `hostRef === null` early-return guard in
 *   `reconcileCreateStart` (the draining revision must park a row whose
 *   pre-written fingerprint it is too old to own) lets the stale revision
 *   provision its own specification onto the advanced incarnation. With
 *   different effective specifications that is an unbounded replacement war,
 *   not one extra replacement, so the orb never converges;
 * - disabling the store's `declined` branch (so a lower generation may request
 *   replacement) livelocks as a replacement war: each revision discards the
 *   other's compute forever.
 *
 * The premise is seeded rather than raced: the fleet starts running on the old
 * specification, so every schedule asserts exactly one forward replacement, one
 * new incarnation, and never a backward one.
 *
 * The create race is modeled separately below: the revision that loses a
 * provision race receives the winner's non-retryable `conflict` while the
 * winner's commit may not have landed yet, so `failOrb` would still CAS cleanly
 * and discard the winner's fresh compute. The start path therefore treats a racing conflict
 * as a reason to re-read and reconcile, never as damage.
 */
describe("mixed-generation reconcilers (DST)", () => {
  it("parks an older revision while a newer generation exceeds its boot deadline", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "mixed-generation-slow-new-boot", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({
          constants: { createStartDeadlineMs: 900_000, idleStopAfterMs: 3_600_000 },
        });
        const oldRevision = makeRevision(harness, OLD_GENERATION, OLD_SPEC, 180_000);
        const newRevision = makeRevision(harness, NEW_GENERATION, NEW_SPEC, 720_000);
        const stopAll = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler-old", f: (task) => reconcileLoop(task, oldRevision, stopAll.signal) },
          { name: "reconciler-new", f: (task) => reconcileLoop(task, newRevision, stopAll.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOnRevisions(task, harness, ORB, PROJECT, [oldRevision, newRevision], {
                initDurationMs: 1_000,
              });
              harness.world.configureOrb(ORB, { bootLatencyMs: 360_000 });
              const stopped = await requestOrbStop(task, newRevision, ORB);
              expect(stopped.isOk()).toBe(true);
              await waitUntil(
                task,
                "orb stopped before slow boot",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              );
              const started = await requestOrbStart(task, newRevision, ORB);
              expect(started.isOk()).toBe(true);
              await waitUntil(task, "slow boot reaches a terminal decision", () => {
                const state = harness.store.orbSnapshot(ORB)?.state;
                return state === "running" || state === "failed";
              });
              stopAll.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("running");
        expect(capture.matching("spec-replacement-declined").length).toBeGreaterThan(0);
        expect(capture.matching("to=failed")).toEqual([]);
      },
    );
  });

  it("adopts another revision's host restart while draining", async () => {
    const capture = new LogCapture();
    let deferredTotal = 0;
    await runDst(
      {
        name: "mixed-generation-drain-restart",
        iterations: 60,
        logCapture: capture,
        lateTimerProbability: 0,
      },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = makeRevision(harness, OLD_GENERATION, OLD_SPEC);
        const newRevision = makeRevision(harness, NEW_GENERATION, NEW_SPEC);
        let stopping = false;
        let firstRestarted = false;
        const waitForStop = async (task: SimulationTask): Promise<void> => {
          while (!stopping) await task.sleep(1, "wait for stopping episode");
        };
        const result = await sim.runTasks([
          {
            name: "reconciler-old",
            f: async (task) => {
              await waitForStop(task);
              while (!firstRestarted) await task.sleep(1, "wait for sibling restart");
              return reconcileOrbOnce(task, oldRevision, ORB);
            },
          },
          {
            name: "reconciler-new",
            f: async (task) => {
              await waitForStop(task);
              const outcome = await reconcileOrbOnce(task, newRevision, ORB);
              firstRestarted = true;
              return outcome;
            },
          },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOnRevisions(task, harness, ORB, PROJECT, [oldRevision, newRevision], {
                initDurationMs: 1_000,
              });
              const expiredByMs = harness.deps.constants.postRestartGraceMs + 1;
              harness.world.backdateHostStart(ORB, expiredByMs);
              const stopped = await requestOrbStop(task, newRevision, ORB);
              expect(stopped.isOk()).toBe(true);
              if (stopped.isErr()) return;
              harness.world.killRuntimeProcess(ORB);
              for (const revision of [oldRevision, newRevision]) {
                revision.control.noteStateEpisode(ORB, stopped.value.stateChangedAt);
                const unansweredAt = task.monotonicNow() - expiredByMs;
                revision.control.resetLivenessBaseline(ORB, unansweredAt);
                revision.control.noteRuntimeRequestStarted(ORB, unansweredAt);
              }
              stopping = true;
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.world.hostStartCountOf(ORB)).toBe(2);
        expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopping");
        deferredTotal += capture.matching("drain-restart-deferred").length;
      },
    );
    expect(deferredTotal).toBeGreaterThan(0);
  });

  it("rejects a stale provision after replacement retired its incarnation", async () => {
    await runDst(
      { name: "mixed-generation-stale-provision", iterations: 20, lateTimerProbability: 0 },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const staleProvider = new StaleObserveProvider(
          () => harness.world.hostCount(ORB),
          harness.world,
          0,
          OLD_GENERATION,
          OLD_SPEC,
        );
        const winnerProvider = new WinnerProvisionProvider(
          staleProvider,
          harness.world,
          0,
          NEW_GENERATION,
          NEW_SPEC,
        );
        const oldRevision = {
          ...harness.deps,
          hostProvider: staleProvider,
          control: new ControlState(),
        };
        const newRevision = {
          ...harness.deps,
          hostProvider: winnerProvider,
          control: new ControlState(),
        };
        const stop = new AbortController();
        const result = await sim.runTasks([
          {
            name: "stale-pass",
            f: async (task) => {
              while (harness.store.orbSnapshot(ORB) === null) {
                await task.sleep(1, "wait for seed");
              }
              const outcome = await reconcileOrbOnce(task, oldRevision, ORB);
              staleProvider.finished = true;
              return outcome;
            },
          },
          {
            name: "winner",
            f: async (task) => {
              while (!staleProvider.entered) await task.sleep(1, "wait for stale observation");
              return reconcileLoop(task, newRevision, stop.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOnRevisions(task, harness, ORB, PROJECT, [oldRevision, newRevision], {
                initDurationMs: 1_000,
              });
              const row = harness.store.orbSnapshot(ORB);
              if (row === null) throw new Error("seeded orb missing");
              harness.store.seedOrb({
                ...row,
                state: "starting",
                stateChangedAt: task.wallNow(),
              });
              await waitUntil(
                task,
                "replacement converges after stale absence",
                () =>
                  harness.store.orbSnapshot(ORB)?.state === "running" &&
                  harness.store.orbSnapshot(ORB)?.hostIncarnation === 1,
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const newFingerprint = winnerProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        expect(harness.world.createdHostsOf(ORB)).toEqual([
          expect.objectContaining({ incarnation: 0 }),
          { incarnation: 1, specFingerprint: newFingerprint },
        ]);
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          state: "running",
          hostIncarnation: 1,
          hostSpecFingerprint: newFingerprint,
        });
      },
    );
  });

  it("removes a stale provider effect while its incarnation discard is pending", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "mixed-generation-pending-discard-provision",
        iterations: 20,
        lateTimerProbability: 0,
        logCapture: capture,
      },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const staleProvider = new LateProvisionProvider(
          () => harness.world.hostCount(ORB),
          harness.world,
          0,
          OLD_GENERATION,
          OLD_SPEC,
        );
        const winnerProvider = new HeldDiscardProvider(
          staleProvider,
          harness.world,
          0,
          NEW_GENERATION,
          NEW_SPEC,
        );
        const oldRevision = {
          ...harness.deps,
          hostProvider: staleProvider,
          control: new ControlState(),
        };
        const newRevision = {
          ...harness.deps,
          hostProvider: winnerProvider,
          control: new ControlState(),
        };
        const stop = new AbortController();
        const result = await sim.runTasks([
          {
            name: "stale-pass",
            f: async (task) => {
              while (harness.store.orbSnapshot(ORB) === null) {
                await task.sleep(1, "wait for seed");
              }
              const outcome = await reconcileOrbOnce(task, oldRevision, ORB);
              staleProvider.finished = true;
              return outcome;
            },
          },
          {
            name: "winner",
            f: async (task) => {
              while (!staleProvider.provisionEntered) {
                await task.sleep(1, "wait for stale provision call");
              }
              return reconcileLoop(task, newRevision, stop.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOnRevisions(task, harness, ORB, PROJECT, [oldRevision, newRevision], {
                initDurationMs: 1_000,
              });
              const row = harness.store.orbSnapshot(ORB);
              if (row === null) throw new Error("seeded orb missing");
              harness.store.seedOrb({ ...row, state: "starting", stateChangedAt: task.wallNow() });
              await waitUntil(
                task,
                "replacement converges after stale provider effect",
                () =>
                  harness.store.orbSnapshot(ORB)?.state === "running" &&
                  harness.store.orbSnapshot(ORB)?.hostIncarnation === 1,
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("superseded-provision-discard")).toHaveLength(1);
        expect(harness.world.createdHostsOf(ORB).map(({ incarnation }) => incarnation)).toEqual([
          0, 0, 1,
        ]);
        expect(harness.world.hostCount(ORB)).toBe(1);
        expect(harness.world.hostIncarnationOf(ORB)).toBe(1);
        expect(harness.world.filesystemExists(ORB)).toBe(true);
      },
    );
  });

  it("replaces a stale host forward once and never backward during a rollover", async () => {
    const capture = new LogCapture();
    // The declined guard fires only in schedules where a stale pass actually
    // reached the start path, so its presence is asserted over the whole
    // iteration budget rather than per schedule.
    let declinedTotal = 0;
    await runDst(
      {
        name: "mixed-generation-rollover",
        iterations: 40,
        logCapture: capture,
      },
      async (sim) => {
        // Idle auto-stop is out of scope: the orb is deliberately held running
        // across long virtual stretches with no activity.
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = makeRevision(harness, OLD_GENERATION, OLD_SPEC);
        const newRevision = makeRevision(harness, NEW_GENERATION, NEW_SPEC);
        const oldFingerprint = oldRevision.hostProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        const newFingerprint = newRevision.hostProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        // The old revision drains away first; the new one outlives it.
        const drainOld = new AbortController();
        const stopAll = new AbortController();
        const result = await sim.runTasks([
          {
            name: "reconciler-old",
            f: (task) => reconcileLoop(task, oldRevision, drainOld.signal),
          },
          // Successful pulls are the only liveness signal, so each revision
          // polls as well; without them a `running` orb is restarted every
          // grace period (docs/testing.md standing interplay).
          { name: "poller-old", f: (task) => pollLoop(task, oldRevision, drainOld.signal) },
          { name: "reconciler-new", f: (task) => reconcileLoop(task, newRevision, stopAll.signal) },
          { name: "poller-new", f: (task) => pollLoop(task, newRevision, stopAll.signal) },
          {
            name: "driver",
            f: async (task) => {
              // The premise is deterministic: the fleet is already running the
              // old revision's specification when the new one arrives, so
              // every schedule has exactly one stale host to replace.
              seedRunningOnRevisions(task, harness, ORB, PROJECT, [oldRevision, newRevision], {
                initDurationMs: 1_000,
              });
              // A desired-spec update never bounces healthy running compute,
              // even while both revisions repeatedly reconcile it.
              const running = harness.store.orbSnapshot(ORB);
              const runningRef = running?.hostRef;
              await task.sleep(10_000, "observe running orb under version skew");
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostRef: runningRef,
                hostIncarnation: 0,
                hostSpecFingerprint: oldFingerprint,
              });
              expect(harness.world.specFingerprintOf(ORB)).toBe(oldFingerprint);
              // The ordinary stop/start is the only replacement trigger.
              await stopStartCycle(task, newRevision, harness, capture, "replacement cycle");
              drainOld.abort();
              // The survivor must now own the host outright, and a second
              // stop/start of an already-current specification replaces
              // nothing at all.
              await stopStartCycle(task, newRevision, harness, capture, "same-spec cycle");
              stopAll.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);

        const orb = harness.store.orbSnapshot(ORB);
        // (a) The surviving revision owns the compute outright, in the durable
        // row *and* on the host itself — a row rewritten around untouched
        // compute would pass the first assertion and fail the second.
        expect(orb?.hostSpecGeneration).toBe(NEW_GENERATION);
        expect(orb?.hostSpecFingerprint).toBe(newFingerprint);
        expect(harness.world.specFingerprintOf(ORB)).toBe(newFingerprint);
        // (b) Exactly one replacement, exactly one new incarnation: the stale
        // host is replaced on its first stop/start and nothing is replaced
        // afterwards. The creation history is the world's own ground truth,
        // which no row rewrite can fake.
        const discardRequests = capture.matching("compute-discard-requested");
        expect(discardRequests).toHaveLength(1);
        expect(discardRequests[0]).toContain("reason=host_spec_changed");
        expect(orb?.hostIncarnation).toBe(1);
        expect(harness.world.createdHostsOf(ORB)).toEqual([
          { incarnation: 0, specFingerprint: oldFingerprint },
          { incarnation: 1, specFingerprint: newFingerprint },
        ]);
        // (c) The skew must not deny service — neither by livelock nor by a
        // terminal failure decided on another episode's clocks.
        expect(orb?.state).toBe("running");
        expect(capture.matching("to=failed")).toEqual([]);
        // (d) A lower-generation guard is observable whenever it wins a stale
        // pass, and deduped per episode: the old revision is alive for at most
        // the first stop/start episode, so one edge is the ceiling.
        const declined = capture.matching("spec-replacement-declined");
        expect(declined.length).toBeLessThanOrEqual(1);
        declinedTotal += declined.length;
      },
    );
    expect(declinedTotal).toBeGreaterThan(0);
  });

  it("recovers a provision conflict before the winning revision commits", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "mixed-generation-forced-create-conflict",
        iterations: 10,
        logCapture: capture,
        lateTimerProbability: 0,
      },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = makeRevision(harness, OLD_GENERATION, OLD_SPEC);
        const newRevision = makeRevision(harness, NEW_GENERATION, NEW_SPEC);
        const fingerprint = newRevision.hostProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        let winnerProvisioned = false;
        let releaseWinner = false;
        let observedConflict = false;
        const provisionWinner = newRevision.hostProvider.provision.bind(newRevision.hostProvider);
        newRevision.hostProvider.provision = (...args) =>
          provisionWinner(...args).andThen((host) =>
            ResultAsync.fromSafePromise(
              (async () => {
                winnerProvisioned = true;
                await waitUntil(
                  args[0],
                  "loser reconciles before winner commit",
                  () => releaseWinner,
                );
                return host;
              })(),
            ),
          );
        const provisionLoser = oldRevision.hostProvider.provision.bind(oldRevision.hostProvider);
        oldRevision.hostProvider.provision = (...args) =>
          provisionLoser(...args).mapErr((error) => {
            expect(error).toMatchObject({ code: "conflict", retryable: false });
            expect(harness.store.orbSnapshot(ORB)?.hostRef).toBeNull();
            observedConflict = true;
            return error;
          });
        const stop = new AbortController();
        const result = await sim.runTasks([
          {
            name: "winner",
            f: async (task) => {
              harness.world.configureOrb(ORB, { initDurationMs: 1_000 });
              harness.store.seedProject(makeProjectRow(PROJECT));
              harness.store.seedOrb(
                makeOrbRow(ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }),
              );
              await reconcileOrbOnce(task, newRevision, ORB);
              await reconcileLoop(task, newRevision, stop.signal);
            },
          },
          { name: "poller", f: (task) => pollLoop(task, newRevision, stop.signal) },
          {
            name: "loser",
            f: async (task) => {
              await waitUntil(
                task,
                "winner compute exists without a row commit",
                () => winnerProvisioned,
              );
              expect((await reconcileOrbOnce(task, oldRevision, ORB)).type).toBe("conflict");
              expect(observedConflict).toBe(true);
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "creating",
                hostRef: null,
                hostDiscardThroughIncarnation: null,
              });
              const winnerRef = harness.world.hostRefOf(ORB);
              expect(winnerRef).not.toBeNull();
              expect(harness.world.createdHostsOf(ORB)).toEqual([
                { incarnation: 0, specFingerprint: fingerprint },
              ]);
              releaseWinner = true;
              await waitUntil(
                task,
                "winner recovers to running",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 300_000 },
              );
              await reconcileOrbOnce(task, oldRevision, ORB);
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostRef: winnerRef?.resourceId,
                hostSpecFingerprint: fingerprint,
                hostIncarnation: 0,
              });
              expect(harness.world.createdHostsOf(ORB)).toEqual([
                { incarnation: 0, specFingerprint: fingerprint },
              ]);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("to=failed")).toEqual([]);
        expect(capture.matching("compute-discard-requested")).toEqual([]);
      },
    );
  });

  it("converges a raced first provision without failing the orb", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "mixed-generation-create-race", iterations: 30, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = makeRevision(harness, OLD_GENERATION, OLD_SPEC);
        const newRevision = makeRevision(harness, NEW_GENERATION, NEW_SPEC);
        const oldFingerprint = oldRevision.hostProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        const newFingerprint = newRevision.hostProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        const stopAll = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler-old", f: (task) => reconcileLoop(task, oldRevision, stopAll.signal) },
          { name: "poller-old", f: (task) => pollLoop(task, oldRevision, stopAll.signal) },
          { name: "reconciler-new", f: (task) => reconcileLoop(task, newRevision, stopAll.signal) },
          { name: "poller-new", f: (task) => pollLoop(task, newRevision, stopAll.signal) },
          {
            name: "driver",
            f: async (task) => {
              // Both revisions meet the orb in `creating` with no host at all:
              // whoever provisions second gets the winner's non-retryable
              // conflict, in the window before the winner's commit.
              harness.world.configureOrb(ORB, { initDurationMs: 1_000 });
              harness.store.seedProject(makeProjectRow(PROJECT));
              harness.store.seedOrb(
                makeOrbRow(ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }),
              );
              await waitUntil(
                task,
                "raced create converges to running",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 900_000 },
              );
              stopAll.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);

        // Losing a provision race is a schedule artifact, never damage: no
        // terminal failure, no failure-driven discard, and never a backward
        // (new-then-old) replacement. Which specification serves first is
        // schedule-dependent — a boot that outruns the new revision's first
        // start pass legitimately serves the old spec until its next Start.
        const orb = harness.store.orbSnapshot(ORB);
        expect(orb?.state).toBe("running");
        expect(capture.matching("to=failed")).toEqual([]);
        for (const request of capture.matching("compute-discard-requested")) {
          expect(request).toContain("reason=host_spec_changed");
        }
        expect([oldFingerprint, newFingerprint]).toContain(orb?.hostSpecFingerprint);
        expect(harness.world.specFingerprintOf(ORB)).toBe(orb?.hostSpecFingerprint);
        const created = harness.world.createdHostsOf(ORB).map((host) => host.specFingerprint);
        expect(created.length).toBeLessThanOrEqual(2);
        expect(created).not.toEqual([newFingerprint, oldFingerprint]);
      },
    );
  });
});
