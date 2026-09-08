import { describe, expect, it } from "vitest";
import { reconcileOrbOnce, requestOrbStart } from "../../domain/lifecycle.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "../../testkit/fixtures.ts";
import { DeterministicGceApiModel } from "../../testkit/gce-model.ts";
import { runDst } from "../../testkit/sim.ts";
import { GceOrbHostProvider, type GceOrbHostProviderOptions } from "./provider.ts";

const ORB = "orb-gce-discard";
const PROJECT = "project-gce-discard";
const DISK = `pi-orb-data-${ORB}`;

const instanceName = (incarnation: number): string => `pi-orb-${ORB}-i${incarnation}`;

/** Seed the orb's modeled compute: one instance per incarnation, plus the data disk. */
function seedOrbCompute(
  model: DeterministicGceApiModel,
  incarnations: number[],
  options: { disk?: boolean } = {},
): void {
  if (options.disk ?? true) model.seedDisk(DISK, { "pi-orb-orb-id": ORB });
  for (const incarnation of incarnations) {
    model.seedInstance(instanceName(incarnation), {
      "pi-orb-orb-id": ORB,
      "pi-orb-host-incarnation": String(incarnation),
    });
  }
}

function provider(
  model: DeterministicGceApiModel,
  overrides: Partial<
    Pick<
      GceOrbHostProviderOptions,
      "imageResource" | "imageId" | "workspaceImageResource" | "workspaceImageId"
    >
  > = {},
): GceOrbHostProvider {
  return new GceOrbHostProvider(model, {
    projectId: "proj",
    zone: "us-central1-a",
    machineType: "n2d-highmem-4",
    subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
    serviceAccount: "orb-vm@proj.iam.gserviceaccount.com",
    imageResource: "projects/projxx/global/images/pi-orb-native-20260905",
    imageId: "123456789",
    workspaceImageResource: "projects/projxx/global/images/pi-orb-workspace-20260908",
    workspaceImageId: "223456789",
    controlPlaneUrl: "https://runtime.example",
    ...overrides,
  });
}

const anyContext = (): { signal: AbortSignal } => ({
  signal: new AbortController().signal,
});

/** Read modeled instance state back through the transport the adapter uses. */
async function instanceStatus(
  model: DeterministicGceApiModel,
  name: string,
): Promise<string | null> {
  const response = await model.request({
    method: "GET",
    path: `projects/proj/zones/us-central1-a/instances/${name}`,
    ...anyContext(),
  });
  return response.status === 200 ? String(response.body["status"] ?? "") : null;
}

/** The orb's instances as the API would list them. */
async function listOrbInstances(model: DeterministicGceApiModel): Promise<string[]> {
  const response = await model.request({
    method: "GET",
    path: `projects/proj/zones/us-central1-a/instances?filter=labels.pi-orb-orb-id%3D${ORB}`,
    ...anyContext(),
  });
  const items = (response.body["items"] ?? []) as Record<string, unknown>[];
  return items.map((item) => String(item["name"] ?? ""));
}

describe("GCE adapter over deterministic stateful model (DST)", () => {
  it("pins concurrent first provisioning to one accepted workspace image", async () => {
    await runDst({ name: "gce-model-concurrent-workspace-create", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({ operationWaitPolls: 1 });
      const result = await sim.runTasks(
        [provider(model), provider(model)].map((gce, index) => ({
          name: `provisioner-${index}`,
          f: async (task: SimulationTask) => {
            await gce.provision(
              task,
              {
                orbId: ORB,
                incarnation: 0,
                bootstrap: { repositoryUrl: "https://github.com/o/r" },
              },
              anyContext(),
            );
          },
        })),
      );
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(model.diskSnapshot(DISK)).toMatchObject({
        labels: { "pi-orb-orb-id": ORB },
        sourceImage: "projects/projxx/global/images/pi-orb-workspace-20260908",
        sourceImageId: "223456789",
      });
      expect(await listOrbInstances(model)).toEqual([instanceName(0)]);
    });
  });

  it("waits for asynchronous deletion, tolerates delayed visibility, and fences newer compute", async () => {
    await runDst({ name: "gce-model-discard-fence", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({
        operationWaitPolls: 2,
        deletionVisibilityPolls: 1,
      });
      seedOrbCompute(model, [0, 1, 2]);

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
      seedOrbCompute(model, [0]);
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

  it("refuses a foreign retained disk before provisioning replacement compute", async () => {
    await runDst({ name: "gce-model-foreign-retained-disk", iterations: 10 }, async (sim) => {
      const model = new DeterministicGceApiModel();
      model.seedDisk(DISK, { "pi-orb-orb-id": "another-orb" });
      const result = await sim.runTasks([
        {
          name: "provisioner",
          f: async (task) => {
            const provisioned = await provider(model).provision(
              task,
              {
                orbId: ORB,
                incarnation: 1,
                bootstrap: { repositoryUrl: "https://github.com/o/r" },
              },
              anyContext(),
            );
            expect(provisioned.isErr() && provisioned.error.code).toBe("conflict");
            expect(provisioned.isErr() && provisioned.error.retryable).toBe(false);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(model.hasInstance(instanceName(1))).toBe(false);
      expect(model.hasDisk(DISK)).toBe(true);
    });
  });

  it("surfaces a failed retained-disk GET without provisioning compute", async () => {
    await runDst({ name: "gce-model-retained-disk-get-failure", iterations: 10 }, async (sim) => {
      const model = new DeterministicGceApiModel({ diskGetStatus: 503 });
      const result = await sim.runTasks([
        {
          name: "provisioner",
          f: async (task) => {
            const provisioned = await provider(model).provision(
              task,
              {
                orbId: ORB,
                incarnation: 1,
                bootstrap: { repositoryUrl: "https://github.com/o/r" },
              },
              anyContext(),
            );
            expect(provisioned.isErr() && provisioned.error.code).toBe("unavailable");
            expect(provisioned.isErr() && provisioned.error.retryable).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(model.hasInstance(instanceName(1))).toBe(false);
    });
  });

  it("a late stale discard cannot touch the explicitly started replacement", async () => {
    await runDst({ name: "gce-model-late-stale-discard", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({
        operationWaitPolls: 2,
        deletionVisibilityPolls: 1,
      });
      seedOrbCompute(model, [0]);

      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow(PROJECT));
      harness.store.seedOrb(
        makeOrbRow(ORB, PROJECT, "failed", {
          hostKind: "gce",
          hostRef: instanceName(0),
          hostIncarnation: 0,
          hostDiscardThroughIncarnation: 0,
          hostDiscardReason: "failed",
          hostDiscardRequestedAt: 1,
          lastError: "runtime_failed: model failure",
        }),
      );
      const gce = provider(model);
      const deps = { ...harness.deps, hostProvider: gce };

      const result = await sim.runTasks([
        {
          name: "replacement",
          f: async (task) => {
            // fail → discard → finalize.
            for (let attempt = 0; attempt < 20; attempt++) {
              await reconcileOrbOnce(task, deps, ORB);
              if (harness.store.orbSnapshot(ORB)?.hostDiscardThroughIncarnation === null) break;
              await task.sleep(1, "retry modeled GCE discard");
            }
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "failed",
              hostRef: null,
              hostIncarnation: 1,
              hostDiscardThroughIncarnation: null,
            });

            // Explicit Start provisions the clean incarnation 1 around the
            // retained data disk.
            const started = await requestOrbStart(task, deps, ORB);
            expect(started.isOk(), started.isErr() ? JSON.stringify(started.error) : "").toBe(true);
            for (let attempt = 0; attempt < 50; attempt++) {
              await reconcileOrbOnce(task, deps, ORB);
              if (harness.store.orbSnapshot(ORB)?.hostRef !== null) break;
              await task.sleep(1, "wait for replacement provision");
            }
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "starting",
              hostRef: instanceName(1),
              hostIncarnation: 1,
            });
            expect(model.hasInstance(instanceName(1))).toBe(true);

            // A disposal call from the previous episode arrives only now —
            // a crashed reconciler's retry, or a slow provider path. The
            // incarnation fence must make it a no-op.
            const stale = await gce.discardCompute(
              task,
              { orbId: ORB, throughIncarnation: 0 },
              { signal: new AbortController().signal },
            );
            expect(stale.isOk(), stale.isErr() ? JSON.stringify(stale.error) : "").toBe(true);
            expect(model.hasInstance(instanceName(1))).toBe(true);
            expect(model.hasDisk(DISK)).toBe(true);

            // The orb stays on its healthy replacement episode: further
            // reconciliation neither fails it nor re-enters disposal.
            for (let attempt = 0; attempt < 5; attempt++) {
              await reconcileOrbOnce(task, deps, ORB);
              await task.sleep(1, "post-stale-discard reconcile");
            }
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "starting",
              hostRef: instanceName(1),
              hostIncarnation: 1,
              hostDiscardThroughIncarnation: null,
            });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(model.hasInstance(instanceName(1))).toBe(true);
      expect(model.hasDisk(DISK)).toBe(true);
    });
  });

  it("replaces stopped stale-spec compute instead of repairing or booting it", async () => {
    await runDst({ name: "gce-model-spec-replacement", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({
        operationWaitPolls: 1,
        deletionVisibilityPolls: 1,
      });
      const bootstrap = { repositoryUrl: "https://github.com/o/r" };
      const result = await sim.runTasks([
        {
          name: "spec-replacement",
          f: async (task) => {
            // The deployed revision creates the orb's compute and stops it.
            const deployed = provider(model);
            const provisioned = await deployed.provision(
              task,
              { orbId: ORB, incarnation: 0, bootstrap },
              anyContext(),
            );
            expect(provisioned.isOk(), JSON.stringify(provisioned)).toBe(true);
            if (provisioned.isErr()) return;
            expect((await deployed.stop(task, provisioned.value.ref, anyContext())).isOk()).toBe(
              true,
            );
            expect(await instanceStatus(model, instanceName(0))).toBe("TERMINATED");

            // A new revision desires a different runtime image: the existing
            // stopped instance is stale specification, not repairable input.
            const updated = provider(model, {
              imageResource: "projects/projxx/global/images/pi-orb-native-other",
              imageId: "987654321",
              workspaceImageResource: "projects/projxx/global/images/pi-orb-workspace-other",
              workspaceImageId: "99887766",
            });
            const desired = updated.desiredSpecFingerprint({
              orbId: ORB,
              ...bootstrap,
            });
            expect(desired).not.toBe(provisioned.value.specFingerprint);
            expect(
              provider(model, {
                workspaceImageResource: "projects/projxx/global/images/pi-orb-workspace-other",
                workspaceImageId: "99887766",
              }).desiredSpecFingerprint({ orbId: ORB, ...bootstrap }),
            ).toBe(provisioned.value.specFingerprint);

            // Neither entry point may adopt it, and neither may boot it: a
            // successful start here would run the old image on the workspace.
            const reprovisioned = await updated.provision(
              task,
              { orbId: ORB, incarnation: 0, bootstrap },
              anyContext(),
            );
            expect(reprovisioned.isErr() && reprovisioned.error.code).toBe("conflict");
            expect(reprovisioned.isErr() && reprovisioned.error.retryable).toBe(false);
            const started = await updated.start(
              task,
              {
                ref: provisioned.value.ref,
                expectedIncarnation: 0,
                expectedSpecFingerprint: desired,
              },
              anyContext(),
            );
            expect(started.isErr() && started.error.code).toBe("conflict");
            expect(started.isErr() && started.error.retryable).toBe(false);
            // The model throws on setMetadata, so reaching here at all proves
            // no in-place repair was attempted; the VM also never booted.
            expect(await instanceStatus(model, instanceName(0))).toBe("TERMINATED");

            // Forward through the fence: discard the stale incarnation, then
            // create the replacement around the retained workspace disk.
            // Deletion visibility trails the operation, so absence is only
            // reported on a later pass: the caller retries, exactly like the
            // reconciler does.
            let discarded = await updated.discardCompute(
              task,
              { orbId: ORB, throughIncarnation: 0 },
              anyContext(),
            );
            for (let attempt = 0; attempt < 10 && discarded.isErr(); attempt += 1) {
              expect(discarded.error.retryable).toBe(true);
              await task.sleep(1, "retry discard past delayed deletion visibility");
              discarded = await updated.discardCompute(
                task,
                { orbId: ORB, throughIncarnation: 0 },
                anyContext(),
              );
            }
            expect(discarded.isOk(), JSON.stringify(discarded)).toBe(true);
            const replacement = await updated.provision(
              task,
              { orbId: ORB, incarnation: 1, bootstrap },
              anyContext(),
            );
            expect(replacement.isOk(), JSON.stringify(replacement)).toBe(true);
            expect(replacement.isOk() && replacement.value.specFingerprint).toBe(desired);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(await listOrbInstances(model)).toEqual([instanceName(1)]);
      expect(model.hasInstance(instanceName(0))).toBe(false);
      expect(model.hasDisk(DISK)).toBe(true);
      expect(model.diskSnapshot(DISK)?.["sourceImageId"]).toBe("223456789");
    });
  });

  it("recovers when a zone operation completes after its caller process dies", async () => {
    await runDst({ name: "gce-model-operation-after-crash", iterations: 30 }, async (sim) => {
      const model = new DeterministicGceApiModel({ operationWaitPolls: 100 });
      seedOrbCompute(model, [0], { disk: false });
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
