import { describe, expect, it } from "vitest";
import { reconcileOrbOnce } from "../../domain/lifecycle.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { DeterministicGceApiModel } from "../../testkit/gce-model.ts";
import { runDst } from "../../testkit/sim.ts";
import { GceOrbHostProvider } from "./provider.ts";

const ORB = "orb-gce-discard";
const PROJECT = "project-gce-discard";

function provider(model: DeterministicGceApiModel): GceOrbHostProvider {
  return new GceOrbHostProvider(model, {
    projectId: "proj",
    zone: "us-central1-a",
    machineType: "n2d-highmem-4",
    subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
    serviceAccount: "orb-vm@proj.iam.gserviceaccount.com",
    runtimeImage: "us-central1-docker.pkg.dev/proj/pi-orb/runtime@sha256:abc",
    controlPlaneUrl: "https://runtime.example",
  });
}

describe("GCE adapter over deterministic stateful model (DST)", () => {
  it("waits for asynchronous deletion, tolerates delayed visibility, and fences newer compute", async () => {
    await runDst({ name: "gce-model-discard-fence", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({
        operationWaitPolls: 2,
        deletionVisibilityPolls: 1,
      });
      model.seedDisk("pi-orb-data-orb-gce-discard", {
        "pi-orb-orb-id": ORB,
      });
      model.seedInstance("pi-orb-orb-gce-discard-i0", {
        "pi-orb-orb-id": ORB,
        "pi-orb-host-incarnation": "0",
      });
      model.seedInstance("pi-orb-orb-gce-discard-i1", {
        "pi-orb-orb-id": ORB,
        "pi-orb-host-incarnation": "1",
      });
      model.seedInstance("pi-orb-orb-gce-discard-i2", {
        "pi-orb-orb-id": ORB,
        "pi-orb-host-incarnation": "2",
      });

      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow(PROJECT));
      harness.store.seedOrb(
        makeOrbRow(ORB, PROJECT, "failed", {
          hostKind: "gce",
          hostRef: "pi-orb-orb-gce-discard-i1",
          hostIncarnation: 1,
          hostDiscardThroughIncarnation: 1,
          hostDiscardReason: "failed",
          hostDiscardRequestedAt: 1,
          lastError: "runtime_failed: model failure",
        }),
      );
      const deps = { ...harness.deps, hostProvider: provider(model) };

      const result = await sim.runTasks([
        {
          name: "reconciler",
          f: async (task) => {
            for (let attempt = 0; attempt < 20; attempt++) {
              await reconcileOrbOnce(task, deps, ORB);
              if (harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null) break;
              await task.sleep(1, "retry modeled GCE discard");
            }
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.orbSnapshot(ORB)).toMatchObject({
        state: "failed",
        hostRef: null,
        hostIncarnation: 2,
        hostDiscardThroughIncarnation: null,
      });
      expect(model.hasInstance("pi-orb-orb-gce-discard-i0")).toBe(false);
      expect(model.hasInstance("pi-orb-orb-gce-discard-i1")).toBe(false);
      expect(model.hasInstance("pi-orb-orb-gce-discard-i2")).toBe(true);
      expect(model.hasDisk("pi-orb-data-orb-gce-discard")).toBe(true);
    });
  });

  it("creates a higher incarnation around the same persistent disk after discard", async () => {
    await runDst({ name: "gce-model-discard-then-provision", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({ operationWaitPolls: 1 });
      model.seedDisk("pi-orb-data-orb-gce-discard", { "pi-orb-orb-id": ORB });
      model.seedInstance("pi-orb-orb-gce-discard-i0", {
        "pi-orb-orb-id": ORB,
        "pi-orb-host-incarnation": "0",
      });
      const gce = provider(model);
      const result = await sim.runTasks([
        {
          name: "replacement",
          f: async (task) => {
            const discarded = await gce.discardCompute(
              task,
              { orbId: ORB, throughIncarnation: 0 },
              { signal: new AbortController().signal },
            );
            expect(discarded.isOk()).toBe(true);
            const provisioned = await gce.provision(
              task,
              {
                orbId: ORB,
                incarnation: 1,
                bootstrap: { repositoryUrl: "https://github.com/o/r" },
              },
              { signal: new AbortController().signal },
            );
            expect(provisioned.isOk() && provisioned.value).toMatchObject({
              incarnation: 1,
              ref: { resourceId: "pi-orb-orb-gce-discard-i1" },
            });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(model.hasInstance("pi-orb-orb-gce-discard-i0")).toBe(false);
      expect(model.hasInstance("pi-orb-orb-gce-discard-i1")).toBe(true);
      expect(model.hasDisk("pi-orb-data-orb-gce-discard")).toBe(true);
    });
  });

  it("recovers when a zone operation completes after its caller process dies", async () => {
    await runDst({ name: "gce-model-operation-after-crash", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({ operationWaitPolls: 100 });
      model.seedInstance("pi-orb-orb-gce-discard-i0", {
        "pi-orb-orb-id": ORB,
        "pi-orb-host-incarnation": "0",
      });
      const firstProvider = provider(model);
      const abort = new AbortController();
      let firstFailed = false;
      const result = await sim.runTasks([
        {
          name: "old-control-plane",
          f: async (task) => {
            const discarded = await firstProvider.discardCompute(
              task,
              { orbId: ORB, throughIncarnation: 0 },
              { signal: abort.signal },
            );
            expect(discarded.isErr() && discarded.error.code).toBe("cancelled");
            firstFailed = true;
          },
        },
        {
          name: "cloud-and-new-control-plane",
          f: async (task) => {
            while (model.pendingOperationCount() === 0) {
              await task.sleep(1, "wait for old revision delete operation");
            }
            abort.abort();
            // Compute Engine owns an accepted zone operation independently of
            // the caller. Complete it after that caller has been fenced out.
            model.completeAllOperations();
            while (!firstFailed) await task.sleep(1, "wait for old caller to exit");
            const recovered = await provider(model).discardCompute(
              task,
              { orbId: ORB, throughIncarnation: 0 },
              { signal: new AbortController().signal },
            );
            expect(recovered.isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(model.hasInstance("pi-orb-orb-gce-discard-i0")).toBe(false);
    });
  });
});
