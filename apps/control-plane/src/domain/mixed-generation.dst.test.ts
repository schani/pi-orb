import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, type TestHarness } from "../testkit/fixtures.ts";
import { assertAtMostOneHost } from "../testkit/invariants.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { FakeOrbHostProvider } from "../testkit/world.ts";
import { ControlState } from "./control-state.ts";
import { requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type { ControlPlaneDeps } from "./ports.ts";

const ORB = "orb-mixed";
const PROJECT = "project-mixed";
const REPOSITORY_URL = makeProjectRow(PROJECT).repositoryUrl;

/**
 * Two desired specifications live in the fleet during a deploy. Replacement
 * may move only from generation 1 to generation 2, never backward.
 */
const OLD_GENERATION = 1;
const NEW_GENERATION = 2;

/**
 * The two revisions deploy genuinely different *effective* specifications —
 * different runtime digest, startup contract, machine settings — which is what
 * makes their fingerprints differ. The generation is a separate input that
 * only fences who may replace forward, so a redeploy that changes nothing
 * effective still changes no fingerprint and replaces nothing.
 */
const OLD_SPEC = "spec-rollover-old";
const NEW_SPEC = "spec-rollover-new";

/**
 * One control-plane revision: the shared world and store (one fleet, one
 * database) behind its own host provider and its own in-process state — which
 * is exactly how much two Cloud Run revisions share during a rollover.
 */
function revision(
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

/**
 * Seed the orb already `running` on `revisions[0]`'s specification, with every
 * revision's liveness baseline reset — the fleet as it stands the instant a
 * deploy starts. The first host's boot is behind it by construction; every
 * later start pays the full modeled boot latency.
 */
function seedRunningOnRevision(
  task: SimulationTask,
  harness: TestHarness,
  revisions: readonly ControlPlaneDeps[],
): void {
  const owner = revisions[0];
  if (owner === undefined) throw new Error("seedRunningOnRevision needs a revision");
  harness.world.configureOrb(ORB, { initDurationMs: 1_000 });
  harness.store.seedProject(makeProjectRow(PROJECT));
  const provisioned = harness.world.provisionHost(
    task,
    ORB,
    0,
    owner.hostProvider.specGeneration,
    owner.hostProvider.desiredSpecFingerprint({ orbId: ORB, repositoryUrl: REPOSITORY_URL }),
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
  for (const revision of revisions) {
    revision.control.resetLivenessBaseline(ORB, task.monotonicNow());
  }
}

/** A user-driven stop/start round trip: the window the incident lost. */
async function stopStartCycle(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  harness: TestHarness,
): Promise<void> {
  const stopped = await requestOrbStop(task, deps, ORB);
  expect(stopped.isOk(), stopped.isErr() ? stopped.error.message : "").toBe(true);
  await waitUntil(task, "orb stopped", () => harness.store.orbSnapshot(ORB)?.state === "stopped", {
    timeoutMs: 900_000,
  });
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
 * deploy briefly runs a heterogeneous fleet. The 2026-08-06 repair war was
 * emergent behavior of exactly that: two reconcilers each treated the other's
 * expected script as damage. Immutable replacement removes mutation, while
 * the committed generation prevents the old revision from replacing the new
 * revision's compute backward.
 *
 * Falsifiability evidence (mutation testing; re-verify by mutating, running,
 * and reverting — never leave a mutation behind):
 *
 * - disabling the `hostRef === null` early-return guard in
 *   `reconcileCreateStart` (the draining revision must park a row whose
 *   pre-written fingerprint it is too old to own) originally failed at
 *   iteration 5 with "expected 2 to be less than or equal to 1": the stale
 *   revision provisions its own specification onto the advanced incarnation
 *   and the survivor has to replace it again. Re-verified 2026-08-16 by
 *   short-circuiting that condition to `false`, which now fails at iteration 3
 *   with `waitUntil timed out: orb running` — with both revisions carrying
 *   *different* effective specifications (rather than merely different
 *   generations) the unguarded reprovision is not one extra replacement but an
 *   unbounded replacement war, so the orb never converges at all;
 * - disabling the store's `declined` branch (so a lower generation may request
 *   replacement) livelocks as a replacement war: each revision discards the
 *   other's compute forever and the scenario never converges.
 *
 * The premise is seeded rather than raced. An earlier version started both
 * revisions against a `creating` orb and let them race the first provision,
 * which left the outcome — and therefore the correct number of replacements —
 * dependent on who won: roughly half of the sampled schedules replaced nothing
 * and asserted nothing about the fence. Seeding the fleet as it actually
 * stands when a deploy begins (running on the old specification) makes every
 * schedule assert the exact same thing: exactly one forward replacement, one
 * new incarnation, and never a backward one.
 *
 * The create race is modeled separately below: the revision that loses a
 * provision race receives the winner's non-retryable `conflict` while the
 * winner's commit may not have landed yet, so `failOrb` would still CAS
 * cleanly and discard the winner's fresh compute. The start path therefore
 * treats a racing conflict as a reason to re-read and reconcile, never as
 * damage (first observed 2026-08-16 as a terminal `provider_failed` during an
 * ordinary rollover; trace retained under `test-failures/`).
 */
describe("mixed-generation reconcilers (DST)", () => {
  it("replaces a stale host forward once and never backward during a rollover", async () => {
    const capture = new LogCapture();
    // The declined guard fires only in schedules where a stale pass actually
    // reached the start path, so its presence is asserted over the whole
    // iteration budget rather than per schedule.
    let declinedTotal = 0;
    await runDst(
      { name: "mixed-generation-rollover", iterations: 40, logCapture: capture },
      async (sim) => {
        // Idle auto-stop is out of scope: the orb is deliberately held running
        // across long virtual stretches with no activity.
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = revision(harness, OLD_GENERATION, OLD_SPEC);
        const newRevision = revision(harness, NEW_GENERATION, NEW_SPEC);
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
              seedRunningOnRevision(task, harness, [oldRevision, newRevision]);
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
              await stopStartCycle(task, newRevision, harness);
              // The deploy finishes: the drained revision goes away.
              drainOld.abort();
              // The survivor must now own the host outright, and a second
              // stop/start of an already-current specification replaces
              // nothing at all.
              await stopStartCycle(task, newRevision, harness);
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
        assertAtMostOneHost(harness.world, ORB);
      },
    );
    expect(declinedTotal).toBeGreaterThan(0);
  });

  it("converges a raced first provision without failing the orb", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "mixed-generation-create-race", iterations: 30, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
        const oldRevision = revision(harness, OLD_GENERATION, OLD_SPEC);
        const newRevision = revision(harness, NEW_GENERATION, NEW_SPEC);
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
        assertAtMostOneHost(harness.world, ORB);
      },
    );
  });
});
