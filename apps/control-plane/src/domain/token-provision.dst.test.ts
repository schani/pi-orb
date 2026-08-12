import type { SimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, makeOrbRow, makeProjectRow, type TestHarness } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { fakeTokenHash } from "../testkit/world.ts";
import { reconcileOrbOnce, requestOrbStart, requestOrbStop } from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-a";
const PROJECT = "project-a";

function seedCreatingOrb(task: SimulationTask, harness: TestHarness): void {
  harness.store.seedProject(makeProjectRow(PROJECT));
  harness.store.seedOrb(makeOrbRow(ORB, PROJECT, "creating", { stateChangedAt: task.wallNow() }));
}

/** The committed hash must always describe the token the host actually carries. */
function assertHashMatchesHost(harness: TestHarness): string {
  const orb = harness.store.orbSnapshot(ORB);
  const token = harness.world.hostTokenOf(ORB);
  expect(token, "host must carry a runtime token").not.toBeNull();
  if (token === null) throw new Error("unreachable");
  expect(orb?.runtimeTokenHash).toBe(fakeTokenHash(token));
  return token;
}

describe("runtime-token provisioning (DST)", () => {
  it("acceptance: a running orb's committed hash matches its host's token", async () => {
    await runDst({ name: "token-happy-path", iterations: 30 }, async (sim) => {
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
              "orb running",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      assertHashMatchesHost(harness);
    });
  });

  it("stop/start keeps the token; host replacement rotates it", async () => {
    await runDst({ name: "token-rotation", iterations: 25 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      let firstToken = "";
      let secondToken = "";
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initDurationMs: 1_000 });
            seedCreatingOrb(task, harness);
            await waitUntil(
              task,
              "orb running",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 120_000 },
            );
            firstToken = assertHashMatchesHost(harness);

            // Same host incarnation across stop/start: the token survives.
            expect((await requestOrbStop(task, harness.deps, ORB)).isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 120_000 },
            );
            expect((await requestOrbStart(task, harness.deps, ORB)).isOk()).toBe(true);
            await waitUntil(
              task,
              "orb running again",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 120_000 },
            );
            expect(assertHashMatchesHost(harness)).toBe(firstToken);

            // Host replacement is a new incarnation: the token rotates.
            expect((await requestOrbStop(task, harness.deps, ORB)).isOk()).toBe(true);
            await waitUntil(
              task,
              "orb stopped again",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 120_000 },
            );
            harness.world.removeHost(ORB);
            expect((await requestOrbStart(task, harness.deps, ORB)).isOk()).toBe(true);
            await waitUntil(
              task,
              "orb running on replaced host",
              () => harness.store.orbSnapshot(ORB)?.state === "running",
              { timeoutMs: 120_000 },
            );
            secondToken = assertHashMatchesHost(harness);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(secondToken).not.toBe(firstToken);
    });
  });

  it("adopts one replacement after provision succeeds but its store commit fails", async () => {
    await runDst({ name: "replacement-provision-commit-failure", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.world.configureOrb(ORB, { initDurationMs: 0 });
            harness.store.seedProject(makeProjectRow(PROJECT));
            harness.store.seedOrb(
              makeOrbRow(ORB, PROJECT, "starting", {
                hostIncarnation: 1,
                stateChangedAt: task.wallNow(),
              }),
            );
            harness.store.failNextHostReplacementCommits(1);

            let sawUncommittedCompute = false;
            for (let attempt = 0; attempt < 2_000; attempt++) {
              await reconcileOrbOnce(task, harness.deps, ORB);
              const row = harness.store.orbSnapshot(ORB);
              if (harness.world.hostCount(ORB) === 1 && row?.hostRef === null) {
                sawUncommittedCompute = true;
                expect(row.runtimeTokenHash).toBeNull();
                expect(row.hostIncarnation).toBe(1);
              }
              if (row?.state === "running") break;
              await task.sleep(100, "retry replacement commit");
            }
            expect(sawUncommittedCompute).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const row = harness.store.orbSnapshot(ORB);
      expect(row).toMatchObject({ state: "running", hostIncarnation: 1 });
      expect(row?.hostRef).toBe(harness.world.hostRefOf(ORB)?.resourceId);
      expect(row?.runtimeTokenHash).toBe(
        fakeTokenHash(harness.world.hostTokenOf(ORB) ?? "missing"),
      );
      expect(harness.world.hostCount(ORB)).toBe(1);
      expect(harness.world.hostStartCountOf(ORB)).toBe(1);
    });
  });

  it("provision flakes and concurrent reconcilers never leave a stale hash", async () => {
    await runDst(
      {
        name: "token-flaky-provision",
        iterations: 40,
        failpointProbabilities: {
          [FAILPOINTS.providerProvision]: 0.3,
          [FAILPOINTS.providerObserve]: 0.15,
          [FAILPOINTS.storeWrite]: 0.1,
          [FAILPOINTS.storeRead]: 0.05,
          [FAILPOINTS.runtimeHealth]: 0.1,
        },
      },
      async (sim) => {
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
                "orb running despite flakes",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 300_000 },
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        assertHashMatchesHost(harness);
      },
    );
  });
});
