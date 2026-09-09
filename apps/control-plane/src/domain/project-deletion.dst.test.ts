import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedProvisionedHost,
} from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { publishHostedFile } from "./hosting.ts";
import { createOrb } from "./lifecycle.ts";
import { projectDeletionLoop, reconcileLoop } from "./loops.ts";
import { requestProjectDeletion } from "./project-deletion.ts";

const PROJECT = "project-delete";
const ORBS = ["project-orb-running", "project-orb-stopped", "project-orb-archived"] as const;

// Seed directly so all children share one project while exercising different
// lifecycle starting points. The running/stopped hosts both own filesystems;
// the archived row deliberately has no host and still must lose its replica row.
function seed(
  task: import("determined").SimulationTask,
  harness: ReturnType<typeof makeHarness>,
): void {
  harness.store.seedProject(makeProjectRow(PROJECT));
  for (const orbId of ORBS.slice(0, 2)) {
    harness.world.configureOrb(orbId, { initDurationMs: 0 });
    const provisioned = seedProvisionedHost(task, harness, orbId);
    harness.world.finishBoot(task, orbId);
    harness.world.ensureSessionExists(orbId);
    if (orbId === ORBS[1]) harness.world.stopHost(provisioned.ref);
    harness.store.seedOrb(
      makeOrbRow(orbId, PROJECT, orbId === ORBS[0] ? "running" : "stopped", {
        hostRef: provisioned.ref.resourceId,
        runtimeTokenHash: provisioned.runtimeTokenHash,
        checkoutCommit: "commit-0",
        stateChangedAt: task.wallNow(),
      }),
    );
  }
  harness.store.seedOrb(
    makeOrbRow(ORBS[2], PROJECT, "archived", {
      checkoutCommit: "commit-0",
      archivedAt: task.wallNow(),
    }),
  );
}

describe("project deletion (DST)", () => {
  it("atomically fences name and repository edits against deletion", async () => {
    await runDst({ name: "project-metadata-delete-race", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      const original = makeProjectRow(PROJECT);
      harness.store.seedProject(original);
      let edited = false;
      const result = await sim.runTasks([
        {
          name: "edit",
          f: async (task) => {
            const saved = await harness.store.updateProject(task, {
              projectId: PROJECT,
              name: "new name",
              repositoryUrl: "https://github.com/acme/new",
              now: task.wallNow(),
            });
            expect(saved.isOk()).toBe(true);
            edited = saved.isOk() && saved.value !== null;
          },
        },
        {
          name: "delete",
          f: async (task) => {
            expect(
              (
                await harness.store.requestProjectDeletion(task, {
                  projectId: PROJECT,
                  now: task.wallNow(),
                  cleanupAfter: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            const late = await harness.store.updateProject(task, {
              projectId: PROJECT,
              name: "too late",
              repositoryUrl: "https://github.com/acme/late",
              now: task.wallNow(),
            });
            expect(late.isOk() && late.value === null).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.projectSnapshot(PROJECT)).toMatchObject({
        state: "deleting",
        name: edited ? "new name" : original.name,
        repositoryUrl: edited ? "https://github.com/acme/new" : original.repositoryUrl,
      });
    });
  });
  it("fences a child upload racing permanent project deletion", async () => {
    await runDst({ name: "project-delete-hosting-race", iterations: 20 }, async (sim) => {
      const orbId = ORBS[0];
      const harness = makeHarness({
        constants: { deletionQuarantineMs: 2_000 },
        hostingOrbId: orbId,
      });
      let emitted = false;
      const result = await sim.runTasks([
        {
          name: "uploader",
          f: async (task) => {
            seed(task, harness);
            const orb = harness.store.orbSnapshot(orbId);
            expect(orb?.runtimeTokenHash).not.toBeNull();
            if (orb?.runtimeTokenHash === null || orb === null) return;
            const uploaded = await publishHostedFile(
              task,
              harness.deps.hosting,
              {
                ...harness.hosting.request("project-delete-race"),
                runtimeTokenHash: orb.runtimeTokenHash as string,
                incarnation: orb.hostIncarnation,
              },
              {
                next: () =>
                  new ResultAsync(
                    (async () => {
                      if (emitted) return ok(null);
                      emitted = true;
                      const deleted = await requestProjectDeletion(task, harness.deps, PROJECT);
                      return deleted.isErr()
                        ? err({
                            type: "hosting_retryable" as const,
                            message: deleted.error.message,
                          })
                        : ok(new TextEncoder().encode("alpha"));
                    })(),
                  ),
                close: () => okAsync(undefined),
              },
              { signal: new AbortController().signal },
            );
            expect(uploaded.isErr()).toBe(true);
            expect(harness.hosting.current("index.html")).toBeUndefined();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("serializes a child create racing the delete intent", async () => {
    await runDst({ name: "project-delete-create-race", iterations: 50 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow(PROJECT));
      const result = await sim.runTasks([
        {
          name: "delete",
          f: async (task) => {
            const deleted = await requestProjectDeletion(task, harness.deps, PROJECT);
            expect(deleted.isOk()).toBe(true);
          },
        },
        {
          name: "create",
          f: async (task) => {
            const created = await createOrb(task, harness.deps, {
              orbId: "racing-child",
              projectId: PROJECT,
            });
            if (created.isErr()) expect(created.error.code).toBe("conflict");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.store.projectSnapshot(PROJECT)?.state).toBe("deleting");
      const child = harness.store.orbSnapshot("racing-child");
      if (child !== null) {
        expect(child.state).toBe("deleting");
        expect(harness.store.deletionSnapshot(child.id)?.kind).toBe("delete");
      }
    });
  });

  it("atomically fences creation and removes every child resource before the project", async () => {
    await runDst({ name: "project-delete-complete", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "orb-reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "project-finalizer-1",
          f: (task) => projectDeletionLoop(task, harness.deps, stop.signal),
        },
        {
          name: "project-finalizer-2",
          f: (task) => projectDeletionLoop(task, harness.deps, stop.signal),
        },
        {
          name: "driver",
          f: async (task) => {
            seed(task, harness);
            const requested = await requestProjectDeletion(task, harness.deps, PROJECT);
            expect(requested.isOk()).toBe(true);
            expect(harness.store.projectSnapshot(PROJECT)?.state).toBe("deleting");
            for (const orbId of ORBS) {
              expect(harness.store.orbSnapshot(orbId)?.state).toBe("deleting");
              expect(harness.store.deletionSnapshot(orbId)?.kind).toBe("delete");
            }
            const racedCreate = await createOrb(task, harness.deps, {
              orbId: "too-late",
              projectId: PROJECT,
            });
            expect(racedCreate.isErr() && racedCreate.error.code).toBe("conflict");
            await waitUntil(
              task,
              "project fully deleted",
              () => harness.store.projectSnapshot(PROJECT) === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      for (const orbId of ORBS) {
        expect(harness.store.orbSnapshot(orbId)).toBeNull();
        expect(harness.store.deletionSnapshot(orbId)).toBeNull();
        expect(harness.store.replicaRecords(orbId)).toEqual([]);
        expect(harness.world.hostCount(orbId)).toBe(0);
        expect(harness.world.filesystemExists(orbId)).toBe(false);
      }
    });
  });

  it("recovers fan-out and finalization after failures and a control-plane restart", async () => {
    await runDst(
      {
        name: "project-delete-restart",
        iterations: 30,
        failpointProbabilities: {
          [FAILPOINTS.providerDestroy]: 0.2,
          [FAILPOINTS.storeRead]: 0.05,
          [FAILPOINTS.storeWrite]: 0.1,
        },
      },
      async (sim) => {
        let harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
        const firstDeps = harness.deps;
        const stop1 = new AbortController();
        const stop2 = new AbortController();
        let restarted = false;
        const result = await sim.runTasks([
          { name: "orb-reconciler-1", f: (task) => reconcileLoop(task, firstDeps, stop1.signal) },
          {
            name: "project-finalizer-1",
            f: (task) => projectDeletionLoop(task, firstDeps, stop1.signal),
          },
          {
            name: "orb-reconciler-2",
            f: async (task) => {
              await waitUntil(task, "control plane restarted", () => restarted);
              await reconcileLoop(task, harness.deps, stop2.signal);
            },
          },
          {
            name: "project-finalizer-2",
            f: async (task) => {
              await waitUntil(task, "control plane restarted", () => restarted);
              await projectDeletionLoop(task, harness.deps, stop2.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              seed(task, harness);
              while (true) {
                const snapshot = harness.store.projectSnapshot(PROJECT);
                if (snapshot === null || snapshot.state === "deleting") break;
                await requestProjectDeletion(task, firstDeps, PROJECT);
                await task.sleep(100, "retry project delete request");
              }
              await task.sleep(1_000, "allow partial project deletion");
              stop1.abort();
              harness = restartControlPlane(harness);
              restarted = true;
              await waitUntil(
                task,
                "project deletion recovered",
                () => harness.store.projectSnapshot(PROJECT) === null,
                { timeoutMs: 300_000 },
              );
              stop2.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
});
