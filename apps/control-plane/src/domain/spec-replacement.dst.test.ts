import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import {
  desiredSpecFingerprintOf,
  discardFinalized,
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { assertAtMostOneHost } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { FakeOrbHostProvider } from "../testkit/world.ts";
import { ControlState } from "./control-state.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type { ControlPlaneDeps } from "./ports.ts";

const ORB = "orb-spec";
/** `seedRunningOrb` derives the project id from the orb id. */
const PROJECT = `project-of-${ORB}`;
const REPOSITORY_URL = makeProjectRow(PROJECT).repositoryUrl;

/** The specification the fleet deploys after an effective host-spec update. */
const UPDATED_SPEC = "spec-updated";

/** Convergence crosses the modeled 65 s host boot, twice in some scenarios. */
const CONVERGE_MS = 900_000;

/**
 * Wait in short steps. A single long timer is not a long wait to this
 * scheduler: its late-firing exploration can pick that timer and teleport
 * virtual time past every other deadline at once (docs/testing.md).
 */
async function sleepInSteps(task: SimulationTask, totalMs: number, reason: string): Promise<void> {
  const until = task.monotonicNow() + totalMs;
  while (task.monotonicNow() < until) {
    await task.sleep(Math.min(until - task.monotonicNow(), 500), reason);
  }
}

/** A user-driven stop/start round trip — the only replacement trigger there is. */
async function stopStartCycle(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  harness: TestHarness,
): Promise<void> {
  const stopped = await requestOrbStop(task, deps, ORB);
  expect(stopped.isOk(), stopped.isErr() ? stopped.error.message : "").toBe(true);
  await waitUntil(task, "orb stopped", () => harness.store.orbSnapshot(ORB)?.state === "stopped", {
    timeoutMs: CONVERGE_MS,
  });
  const started = await requestOrbStart(task, deps, ORB);
  expect(started.isOk(), started.isErr() ? started.error.message : "").toBe(true);
  await waitUntil(
    task,
    "orb running again",
    () => harness.store.orbSnapshot(ORB)?.state === "running",
    { timeoutMs: CONVERGE_MS },
  );
}

/**
 * Drive one orb by hand until `predicate` holds. Hand-driving is what makes an
 * exact edge count or a "nothing has happened yet" assertion possible: the
 * scenario owns every pass instead of racing a loop that may take several more
 * while the assertion runs.
 */
async function drive(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  reason: string,
  predicate: () => boolean,
  attempts = 200,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await reconcileOrbOnce(task, deps, ORB);
    if (predicate()) return;
    await task.sleep(100, reason);
  }
  expect.fail(`never reached: ${reason}`);
}

/** The workspace identity that must survive every compute replacement. */
function workspaceIdentity(harness: TestHarness): {
  sessionId: string | null;
  records: number;
  exists: boolean;
} {
  return {
    sessionId: harness.world.sessionHeaderOf(ORB)?.id ?? null,
    records: harness.world.entriesOf(ORB).length,
    exists: harness.world.filesystemExists(ORB),
  };
}

/**
 * One control-plane revision: its own provider (deploy generation plus
 * effective specification) and its own in-process state over the shared world
 * and store — as much as two Cloud Run revisions share during a rollover.
 */
function revisionOf(
  harness: TestHarness,
  specGeneration: number,
  desiredSpec: string,
): ControlPlaneDeps {
  return {
    ...harness.deps,
    hostProvider: new FakeOrbHostProvider(harness.world, 50, specGeneration, desiredSpec),
    control: new ControlState(),
  };
}

/** Seed the orb already `running` on one specific revision's specification. */
function seedRunningOnRevision(
  task: SimulationTask,
  harness: TestHarness,
  deps: ControlPlaneDeps,
): void {
  harness.world.configureOrb(ORB, { initDurationMs: 0 });
  harness.store.seedProject(makeProjectRow(PROJECT));
  const provisioned = harness.world.provisionHost(
    task,
    ORB,
    0,
    deps.hostProvider.specGeneration,
    deps.hostProvider.desiredSpecFingerprint({ orbId: ORB, repositoryUrl: REPOSITORY_URL }),
  );
  harness.world.finishBoot(task, ORB);
  harness.world.ensureSessionExists(ORB);
  harness.store.seedOrb(
    makeOrbRow(ORB, PROJECT, "running", {
      hostRef: provisioned.ref.resourceId,
      runtimeTokenHash: provisioned.runtimeTokenHash,
      hostSpecFingerprint: provisioned.specFingerprint,
      hostSpecGeneration: provisioned.specGeneration,
      checkoutCommit: "commit-0",
      stateChangedAt: task.wallNow(),
    }),
  );
  deps.control.resetLivenessBaseline(ORB, task.monotonicNow());
}

/**
 * Immutable host-spec replacement, from the user-visible side
 * (docs/compute-replacement.md): an update never bounces a running orb, it
 * replaces stopped stale compute on the orb's next Start, and an ordinary
 * same-spec stop/start reuses the compute it already has.
 *
 * The scenarios assert the *actual* host through `FakeWorld`, not only the
 * durable row: a row rewritten around untouched compute — the exact shape of
 * the in-place repair this design removed — passes every row assertion and
 * fails the world ones.
 */
describe("host-spec replacement (DST)", () => {
  it("leaves a running orb untouched and replaces it on the next start", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "spec-change-replaces-on-next-start", iterations: 20, logCapture: capture },
      async (sim) => {
        // The orb is deliberately held running with no activity across long
        // virtual stretches, so idle auto-stop is out of scope. So is the
        // unreachable-runtime restart: a scheduler-legal cancelled `observe`
        // plus a lapsed pull is a 10 s liveness gap that correctly restarts the
        // host *through `starting`*, where the stale specification is then
        // replaced exactly as designed (trace-diagnosed 2026-08-16). That is a
        // different premise — this scenario's invariant is that a *deploy*
        // alone never bounces a healthy running orb — so the liveness window is
        // pushed beyond the observation window instead of being raced.
        const harness = makeHarness({
          constants: { idleStopAfterMs: 3_600_000, unreachableGraceMs: 600_000 },
        });
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          // Successful pulls are the only liveness signal: without the poller a
          // `running` orb is restarted every grace period (docs/testing.md).
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              // Flush one record: a session that never flushed anything
              // evaporates with its process by design (docs/history-replication.md),
              // so an empty workspace could not witness workspace survival.
              harness.world.appendMessage(ORB);
              await waitUntil(
                task,
                "first record replicated",
                () => harness.store.replicaRecords(ORB).length === 1,
              );
              const beforeSpec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
              const beforeRef = harness.world.hostRefOf(ORB)?.resourceId ?? null;
              const beforeToken = harness.store.orbSnapshot(ORB)?.runtimeTokenHash ?? null;
              const workspace = workspaceIdentity(harness);

              // The deploy lands: every later reconcile pass computes a
              // different desired fingerprint for this orb.
              harness.world.setDesiredSpec(UPDATED_SPEC);
              const afterSpec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
              expect(afterSpec).not.toBe(beforeSpec);

              // Many reconcile passes later the running incarnation is still
              // the authoritative one, untouched in every respect.
              await sleepInSteps(task, 20_000, "reconcile the running orb under a new spec");
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostRef: beforeRef,
                hostIncarnation: 0,
                hostSpecFingerprint: beforeSpec,
                hostDiscardThroughIncarnation: null,
                runtimeTokenHash: beforeToken,
              });
              expect(harness.world.specFingerprintOf(ORB)).toBe(beforeSpec);
              expect(harness.world.hostRefOf(ORB)?.resourceId).toBe(beforeRef);
              expect(capture.matching("compute-discard-requested")).toEqual([]);
              expect(harness.world.createdHostsOf(ORB)).toHaveLength(1);

              // Only an ordinary stop/start replaces it.
              await stopStartCycle(task, harness.deps, harness);

              const orb = harness.store.orbSnapshot(ORB);
              expect(orb).toMatchObject({
                state: "running",
                hostIncarnation: 1,
                hostSpecFingerprint: afterSpec,
                hostSpecGeneration: harness.deps.hostProvider.specGeneration,
                // The old fence is fully cleared by finalization.
                hostDiscardThroughIncarnation: null,
                hostDiscardReason: null,
                hostDiscardError: null,
                hostDiscardEvidence: null,
                hostDiscardRequestedAt: null,
              });
              expect(orb?.hostRef).not.toBe(beforeRef);
              // The compute is genuinely new and genuinely restamped.
              expect(harness.world.specFingerprintOf(ORB)).toBe(afterSpec);
              expect(harness.world.hostIncarnationOf(ORB)).toBe(1);
              expect(harness.world.createdHostsOf(ORB)).toEqual([
                { incarnation: 0, specFingerprint: beforeSpec },
                { incarnation: 1, specFingerprint: afterSpec },
              ]);
              // A fresh incarnation carries a fresh runtime token.
              expect(orb?.runtimeTokenHash).not.toBe(beforeToken);
              expect(orb?.runtimeTokenHash).not.toBeNull();
              // The authoritative workspace is the same one.
              expect(workspaceIdentity(harness)).toEqual(workspace);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const discardRequests = capture.matching("compute-discard-requested");
        expect(discardRequests).toHaveLength(1);
        expect(discardRequests[0]).toContain("reason=host_spec_changed");
        expect(discardRequests[0]).toContain("through_incarnation=0");
        expect(capture.matching("replacement-provisioned")).toHaveLength(1);
        expect(capture.matching("spec-replacement-declined")).toEqual([]);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });

  it("reuses its compute across an ordinary same-spec stop/start", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "same-spec-stop-start-reuses-compute", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const spec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
              const ref = harness.world.hostRefOf(ORB)?.resourceId ?? null;
              const token = harness.store.orbSnapshot(ORB)?.runtimeTokenHash ?? null;

              await stopStartCycle(task, harness.deps, harness);

              // Nothing changed effectively, so nothing was replaced: same
              // incarnation, same compute identity, same token.
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostRef: ref,
                hostIncarnation: 0,
                hostSpecFingerprint: spec,
                runtimeTokenHash: token,
                hostDiscardThroughIncarnation: null,
              });
              expect(harness.world.hostRefOf(ORB)?.resourceId).toBe(ref);
              expect(harness.world.specFingerprintOf(ORB)).toBe(spec);
              expect(harness.world.createdHostsOf(ORB)).toEqual([
                { incarnation: 0, specFingerprint: spec },
              ]);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("compute-discard-requested")).toEqual([]);
        expect(capture.matching("replacement-provisioned")).toEqual([]);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });

  it("does not replace anything when a redeploy only bumps the generation", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "generation-bump-without-spec-change", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        // The redeployed revision carries a strictly higher deploy generation
        // and the *same* effective specification — the ordinary deploy. Its
        // fingerprint is therefore identical, which is the property that keeps
        // a routine release from churning the whole fleet.
        const redeployed: ControlPlaneDeps = {
          ...harness.deps,
          hostProvider: new FakeOrbHostProvider(
            harness.world,
            50,
            harness.deps.hostProvider.specGeneration + 7,
          ),
          control: new ControlState(),
        };
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, redeployed, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, redeployed, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              redeployed.control.resetLivenessBaseline(ORB, task.monotonicNow());
              const spec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
              expect(
                redeployed.hostProvider.desiredSpecFingerprint({
                  orbId: ORB,
                  repositoryUrl: REPOSITORY_URL,
                }),
              ).toBe(spec);
              const ref = harness.world.hostRefOf(ORB)?.resourceId ?? null;

              await stopStartCycle(task, redeployed, harness);

              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostRef: ref,
                hostIncarnation: 0,
                hostSpecFingerprint: spec,
                // Nothing was committed, so the row still records the
                // generation that committed this fingerprint in the first
                // place: the generation is a property of the stamp, not of
                // whichever revision last looked at it.
                hostSpecGeneration: harness.deps.hostProvider.specGeneration,
                hostDiscardThroughIncarnation: null,
              });
              expect(harness.world.createdHostsOf(ORB)).toHaveLength(1);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(capture.matching("compute-discard-requested")).toEqual([]);
        expect(capture.matching("spec-replacement-declined")).toEqual([]);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });

  it("restarts a legacy unstamped host in place and replaces it on convergence", async () => {
    const capture = new LogCapture();
    // The in-place restart is the point of the scenario, but a scheduler-legal
    // late provider deadline can cancel the `start` half of one attempt, after
    // which the orb correctly reaches the same end state through `starting`
    // instead. The conflict-freedom invariant is asserted on every schedule;
    // that the in-place path is actually exercised is asserted over the budget.
    let inPlaceRestarts = 0;
    await runDst(
      { name: "legacy-unstamped-unreachable-restart", iterations: 15, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              // The pre-Stage-2 cohort: no committed fingerprint, no stamp on
              // the resource. The start path must send `null` and the adapter
              // must match it against the unstamped resource, or every legacy
              // orb wedges on a non-retryable conflict the moment its runtime
              // goes quiet.
              seedRunningOrb(task, harness, ORB, undefined, { legacy: true });
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                hostSpecFingerprint: null,
                hostSpecGeneration: null,
              });
              expect(harness.world.specFingerprintOf(ORB)).toBeNull();
              const legacyRef = harness.world.hostRefOf(ORB)?.resourceId ?? null;
              const startsBefore = harness.world.hostStartCountOf(ORB);

              harness.world.killRuntimeProcess(ORB);
              // Hand-driven, so the check below lands in the pass right after
              // the restart and before any later pass can replace anything.
              await drive(
                task,
                harness.deps,
                "legacy host restarted or left behind",
                () =>
                  harness.world.hostStartCountOf(ORB) > startsBefore ||
                  harness.world.hostIncarnationOf(ORB) !== 0,
                400,
              );
              if (harness.world.hostIncarnationOf(ORB) === 0) {
                // The very same unstamped compute was started again: no
                // conflict, no replacement, no new host.
                inPlaceRestarts += 1;
                expect(harness.world.hostRefOf(ORB)?.resourceId).toBe(legacyRef);
                expect(harness.world.specFingerprintOf(ORB)).toBeNull();
                expect(harness.world.createdHostsOf(ORB)).toHaveLength(1);
                expect(harness.store.orbSnapshot(ORB)?.hostRef).toBe(legacyRef);
              }
              expect(capture.matching("mismatch")).toEqual([]);
              expect(capture.matching("to=failed")).toEqual([]);

              // And it does not wedge: the restart re-enters `starting`, where
              // the unstamped host is stale by definition and is replaced by a
              // stamped incarnation.
              await drive(
                task,
                harness.deps,
                "legacy orb converges after the restart",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                4_000,
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const spec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          state: "running",
          lastError: null,
          hostIncarnation: 1,
          hostSpecFingerprint: spec,
          hostDiscardThroughIncarnation: null,
        });
        expect(harness.world.specFingerprintOf(ORB)).toBe(spec);
        expect(capture.matching("mismatch")).toEqual([]);
        expect(capture.matching("to=failed")).toEqual([]);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
    expect(inPlaceRestarts).toBeGreaterThan(0);
  });

  it("replaces a legacy unstamped host on an ordinary stop/start", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "legacy-unstamped-stop-start-replacement", iterations: 15, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB, undefined, { legacy: true });
              harness.world.appendMessage(ORB);
              await waitUntil(
                task,
                "first record replicated",
                () => harness.store.replicaRecords(ORB).length === 1,
              );
              const workspace = workspaceIdentity(harness);
              const legacyRef = harness.world.hostRefOf(ORB)?.resourceId ?? null;

              await stopStartCycle(task, harness.deps, harness);

              const spec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "running",
                hostIncarnation: 1,
                hostSpecFingerprint: spec,
                hostSpecGeneration: harness.deps.hostProvider.specGeneration,
                hostDiscardThroughIncarnation: null,
              });
              expect(harness.store.orbSnapshot(ORB)?.hostRef).not.toBe(legacyRef);
              expect(harness.world.createdHostsOf(ORB)).toEqual([
                { incarnation: 0, specFingerprint: null },
                { incarnation: 1, specFingerprint: spec },
              ]);
              expect(workspaceIdentity(harness)).toEqual(workspace);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const discardRequests = capture.matching("compute-discard-requested");
        expect(discardRequests).toHaveLength(1);
        expect(discardRequests[0]).toContain("reason=host_spec_changed");
        expect(capture.matching("to=failed")).toEqual([]);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });

  it("resumes a spec replacement from durable state after death at every crash window", async () => {
    // The same modeling as the failure-disposal crash windows
    // (lifecycle.dst.test.ts): drive the machine to the durable state a crash
    // at each named `compute-replacement` checkpoint leaves behind, restart the
    // control plane there, and require convergence to a ready replacement
    // carrying the desired specification.
    const windows: ReadonlyArray<{
      name: string;
      arrange: (task: SimulationTask, harness: TestHarness) => Promise<void>;
      /** What must be durably true while the control plane is dead. */
      assertDurable: (harness: TestHarness, updatedSpec: string) => void;
    }> = [
      {
        // replacement request committed, stale compute still present.
        name: "request-committed",
        arrange: async () => {},
        assertDurable: (harness, updatedSpec) => {
          expect(harness.store.orbSnapshot(ORB)).toMatchObject({
            hostDiscardReason: "host_spec_changed",
            hostDiscardThroughIncarnation: 0,
            // Pre-written at request time and preserved through the crash: the
            // desired specification the replacement must end up carrying.
            hostSpecFingerprint: updatedSpec,
            // Old authorization is revoked in the same transaction.
            runtimeTokenHash: null,
          });
          expect(harness.world.hostCount(ORB)).toBe(1);
        },
      },
      {
        // discard finalized: compute gone, incarnation advanced, and the
        // pre-written fingerprint survives finalization for reason
        // host_spec_changed.
        name: "discard-finalized",
        arrange: async (task, harness) => {
          await drive(task, harness.deps, "drive to finalized discard", () =>
            discardFinalized(harness, ORB),
          );
        },
        assertDurable: (harness, updatedSpec) => {
          expect(harness.store.orbSnapshot(ORB)).toMatchObject({
            hostRef: null,
            hostIncarnation: 1,
            hostSpecFingerprint: updatedSpec,
            hostDiscardThroughIncarnation: null,
          });
          expect(harness.world.hostCount(ORB)).toBe(0);
        },
      },
      {
        // replacement compute exists, its ref/token were never committed.
        name: "before-commit",
        arrange: async (task, harness) => {
          harness.store.failNextHostReplacementCommits(1);
          await drive(
            task,
            harness.deps,
            "drive to uncommitted replacement",
            () =>
              harness.world.hostCount(ORB) === 1 &&
              harness.store.orbSnapshot(ORB)?.hostRef === null,
          );
        },
        assertDurable: (harness, updatedSpec) => {
          expect(harness.store.orbSnapshot(ORB)).toMatchObject({
            hostRef: null,
            hostIncarnation: 1,
          });
          // The compute the crash orphaned is real, and the restarted control
          // plane must adopt exactly it rather than build a second one.
          expect(harness.world.hostCount(ORB)).toBe(1);
          expect(harness.world.specFingerprintOf(ORB)).toBe(updatedSpec);
        },
      },
      {
        // ref/token durable, readiness not yet reached.
        name: "committed",
        arrange: async (task, harness) => {
          await drive(
            task,
            harness.deps,
            "drive to committed replacement",
            // The old ref survives the request itself, so the committed
            // window is the *new* incarnation carrying a ref.
            () => {
              const row = harness.store.orbSnapshot(ORB);
              return row?.hostIncarnation === 1 && row.hostRef !== null;
            },
          );
        },
        assertDurable: (harness, updatedSpec) => {
          expect(harness.store.orbSnapshot(ORB)).toMatchObject({
            hostIncarnation: 1,
            hostSpecFingerprint: updatedSpec,
          });
          expect(harness.world.specFingerprintOf(ORB)).toBe(updatedSpec);
        },
      },
    ];
    for (const window of windows) {
      await runDst(
        { name: `spec-replacement-crash-${window.name}`, iterations: 10 },
        async (sim) => {
          let harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
          let updatedSpec = "";
          const result = await sim.runTasks([
            {
              name: "driver",
              f: async (task) => {
                seedRunningOrb(task, harness, ORB);
                harness.world.setDesiredSpec(UPDATED_SPEC);
                updatedSpec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
                const stopped = await requestOrbStop(task, harness.deps, ORB);
                expect(stopped.isOk()).toBe(true);
                await drive(
                  task,
                  harness.deps,
                  "stop the stale-spec orb",
                  () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                  400,
                );
                const started = await requestOrbStart(task, harness.deps, ORB);
                expect(started.isOk()).toBe(true);
                // Every window begins with the replacement request itself.
                await drive(
                  task,
                  harness.deps,
                  "commit the replacement request",
                  () => harness.store.orbSnapshot(ORB)?.hostDiscardReason === "host_spec_changed",
                  400,
                );
                await window.arrange(task, harness);
                window.assertDurable(harness, updatedSpec);
                // Process death: every in-memory condition and operation handle
                // is lost, durable state alone must carry the replacement.
                harness = restartControlPlane(harness);
                await drive(
                  task,
                  harness.deps,
                  "converge to a ready replacement after process death",
                  () => harness.store.orbSnapshot(ORB)?.state === "running",
                  4_000,
                );
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          expect(harness.store.orbSnapshot(ORB)).toMatchObject({
            state: "running",
            hostIncarnation: 1,
            hostSpecFingerprint: updatedSpec,
            hostDiscardThroughIncarnation: null,
            hostDiscardReason: null,
          });
          expect(harness.store.orbSnapshot(ORB)?.runtimeTokenHash).not.toBeNull();
          expect(harness.world.specFingerprintOf(ORB)).toBe(updatedSpec);
          expect(harness.world.hostCount(ORB)).toBe(1);
          expect(harness.world.filesystemExists(ORB)).toBe(true);
        },
      );
    }
  });

  it("declines replacement once per episode under a lower deploy generation", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "spec-replacement-declined-edge", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const current = revisionOf(harness, 2, "spec-current");
        const stale = revisionOf(harness, 1, "spec-drained");
        const currentSpec = current.hostProvider.desiredSpecFingerprint({
          orbId: ORB,
          repositoryUrl: REPOSITORY_URL,
        });
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOnRevision(task, harness, current);
              const ref = harness.world.hostRefOf(ORB)?.resourceId ?? null;
              const stopped = await requestOrbStop(task, current, ORB);
              expect(stopped.isOk()).toBe(true);
              await drive(
                task,
                current,
                "stop the orb",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                400,
              );
              const started = await requestOrbStart(task, current, ORB);
              expect(started.isOk()).toBe(true);

              // Many passes of the draining revision: it may start the
              // existing compute unchanged, but it may never replace it and
              // announces its refusal exactly once.
              for (let pass = 0; pass < 20; pass++) {
                await reconcileOrbOnce(task, stale, ORB);
                await task.sleep(100, "stale revision reconcile pass");
              }
              expect(capture.matching("spec-replacement-declined")).toHaveLength(1);
              expect(capture.matching("spec-replacement-declined")[0]).toContain(
                "committed_generation=2 configured_generation=1",
              );
              expect(capture.matching("compute-discard-requested")).toEqual([]);
              expect(harness.world.createdHostsOf(ORB)).toHaveLength(1);
              expect(harness.world.specFingerprintOf(ORB)).toBe(currentSpec);
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                hostRef: ref,
                hostIncarnation: 0,
                hostSpecFingerprint: currentSpec,
                hostSpecGeneration: 2,
                hostDiscardThroughIncarnation: null,
              });

              // The surviving revision converges the same compute.
              await drive(
                task,
                current,
                "current revision converges the orb",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                4_000,
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.store.orbSnapshot(ORB)).toMatchObject({
          state: "running",
          hostIncarnation: 0,
          hostSpecFingerprint: currentSpec,
          hostSpecGeneration: 2,
        });
        expect(capture.matching("compute-discard-requested")).toEqual([]);
        expect(capture.matching("spec-replacement-declined")).toHaveLength(1);
        expect(harness.world.createdHostsOf(ORB)).toHaveLength(1);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });

  it("force-replaces a host whose stamp drifted, preserving retained evidence until commit", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "spec-drift-forced-replacement", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const evidence = "prior failure: container exited 1 after 3 restarts";
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const spec = desiredSpecFingerprintOf(harness, ORB, REPOSITORY_URL);
              const seeded = harness.store.orbSnapshot(ORB);
              if (seeded === null) throw new Error("seeded orb missing");
              const staleRef = seeded.hostRef;
              // A `starting` orb whose row still carries the bounded evidence
              // of the failure that preceded this episode.
              harness.store.seedOrb(
                makeOrbRow(ORB, PROJECT, "starting", {
                  hostRef: seeded.hostRef,
                  hostIncarnation: 0,
                  hostSpecFingerprint: seeded.hostSpecFingerprint,
                  hostSpecGeneration: seeded.hostSpecGeneration,
                  runtimeTokenHash: seeded.runtimeTokenHash,
                  hostDiscardEvidence: evidence,
                  checkoutCommit: "commit-0",
                  stateChangedAt: task.wallNow(),
                }),
              );
              // The compute does not match what the row says it is: another
              // revision, or an out-of-band rebuild, left a different stamp.
              harness.world.setHostSpecFingerprint(ORB, `${spec}-drifted`);

              await drive(
                task,
                harness.deps,
                "force a replacement request on the drifted stamp",
                () => harness.store.orbSnapshot(ORB)?.hostDiscardReason === "host_spec_changed",
                400,
              );
              // The request preserves retained evidence: it is not this
              // episode's to clear (docs/compute-replacement.md rule 5).
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                hostDiscardThroughIncarnation: 0,
                hostDiscardEvidence: evidence,
                hostSpecFingerprint: spec,
                runtimeTokenHash: null,
              });

              await drive(task, harness.deps, "finalize the forced discard", () =>
                discardFinalized(harness, ORB),
              );
              // Finalization retains it too — only a successful replacement
              // ends its usefulness.
              expect(harness.store.orbSnapshot(ORB)?.hostDiscardEvidence).toBe(evidence);

              await drive(
                task,
                harness.deps,
                "converge to the forced replacement",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                4_000,
              );
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                hostIncarnation: 1,
                hostSpecFingerprint: spec,
                // Cleared by the replacement commit, and only by it.
                hostDiscardEvidence: null,
              });
              expect(harness.store.orbSnapshot(ORB)?.hostRef).not.toBe(staleRef);
              expect(harness.world.specFingerprintOf(ORB)).toBe(spec);
              expect(harness.world.createdHostsOf(ORB)).toEqual([
                { incarnation: 0, specFingerprint: spec },
                { incarnation: 1, specFingerprint: spec },
              ]);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        const discardRequests = capture.matching("compute-discard-requested");
        expect(discardRequests).toHaveLength(1);
        expect(discardRequests[0]).toContain("reason=host_spec_changed");
        expect(capture.matching("to=failed")).toEqual([]);
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });
});
