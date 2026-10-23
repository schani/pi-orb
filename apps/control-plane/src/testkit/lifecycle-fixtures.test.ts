import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeHarness, makeRevision, seedRunningOnRevisions } from "./fixtures.ts";
import { sleepInSteps } from "./sim.ts";

class ClockTask extends NoSimulationTask {
  now = 100;
  readonly sleeps: [number, string][] = [];
  override monotonicNow() {
    return this.now;
  }
  override wallNow() {
    return 1_767_225_600_000 + this.now;
  }
  override sleep(ms: number, reason: string) {
    this.sleeps.push([ms, reason]);
    this.now += ms;
    return Promise.resolve();
  }
}

describe("lifecycle fixture mechanics", () => {
  it("chunks virtual waits without changing their duration or reason", async () => {
    const task = new ClockTask("chunked wait", false);
    await sleepInSteps(task, 1_200, "retain this reason");
    expect(task.sleeps).toEqual([
      [500, "retain this reason"],
      [500, "retain this reason"],
      [200, "retain this reason"],
    ]);
    expect(task.monotonicNow()).toBe(1_300);
    await sleepInSteps(task, 0, "no timer");
    expect(task.sleeps).toHaveLength(3);
  });

  it.each([0, 1_000])(
    "seeds explicit owner, project and %ims initialization for independent revisions",
    (initDurationMs) => {
      const task = new ClockTask("revision seed", false);
      const harness = makeHarness();
      const owner = makeRevision(harness, 2, "owner", 720_000);
      const sibling = makeRevision(harness, 1, "sibling", 180_000);
      expect(owner.control).not.toBe(sibling.control);
      expect(owner.constants.unreachableBootDeadlineMs).toBe(720_000);
      expect(sibling.constants.unreachableBootDeadlineMs).toBe(180_000);
      const orbId = "explicit-orb";
      const projectId = "explicit-project";
      seedRunningOnRevisions(task, harness, orbId, projectId, [owner, sibling], { initDurationMs });
      const row = harness.store.orbSnapshot(orbId);
      expect(row).toMatchObject({
        projectId,
        state: "running",
        hostSpecGeneration: 2,
        checkoutCommit: "commit-0",
        hostSpecFingerprint: owner.hostProvider.desiredSpecFingerprint({
          orbId,
          repositoryUrl: harness.store.projectSnapshot(projectId)?.repositoryUrl ?? "",
        }),
        lastReadyAt: task.wallNow(),
        stateChangedAt: task.wallNow(),
      });
      for (const revision of [owner, sibling])
        expect(revision.control.getLiveness(orbId)?.lastSuccessAt).toBe(task.monotonicNow());
      const state = harness.world.resolveRuntime(`http://${row?.hostRef}:8080`, task);
      expect(state).not.toBeNull();
      if (state === null) return;
      expect(harness.world.runtimeHealth(task, state).status).toBe(
        initDurationMs === 0 ? "ready" : "initializing",
      );
    },
  );
});
