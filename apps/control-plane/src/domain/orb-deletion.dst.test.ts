import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeHarness, restartControlPlane, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { publishHostedFile } from "./hosting.ts";
import {
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-delete";

describe("orb deletion (DST)", () => {
  it("removes host, authoritative filesystem, replica, row, and tombstone", async () => {
    await runDst({ name: "delete-complete", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
            const deleted = await requestOrbDeletion(task, harness.deps, ORB);
            expect(deleted.isOk()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)?.state).toBe("deleting");
            expect((await requestOrbStart(task, harness.deps, ORB)).isErr()).toBe(true);
            expect((await requestOrbStop(task, harness.deps, ORB)).isErr()).toBe(true);
            await waitUntil(
              task,
              "orb fully deleted",
              () => harness.store.orbSnapshot(ORB) === null,
              {
                timeoutMs: 120_000,
              },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.world.hostCount(ORB)).toBe(0);
      expect(harness.world.filesystemExists(ORB)).toBe(false);
      expect(harness.store.replicaRecords(ORB)).toEqual([]);
      expect(harness.store.deletionSnapshot(ORB)).toBeNull();
    });
  });

  it("does not finalize the orb while hosted bytes remain", async () => {
    await runDst({ name: "delete-cleans-hosted-files", iterations: 12 }, async (sim) => {
      const harness = makeHarness({
        constants: { deletionQuarantineMs: 2_000 },
        hostingOrbId: ORB,
      });
      harness.hosting.seedCompletedUpload();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            expect((await requestOrbDeletion(task, harness.deps, ORB)).isOk()).toBe(true);
            await waitUntil(
              task,
              "hosted cleanup before row removal",
              () => harness.store.orbSnapshot(ORB) === null,
              { timeoutMs: 120_000 },
            );
            expect(harness.hosting.ownedObjects()).toEqual([]);
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("an archive fence prevents an already reserved upload from publishing", async () => {
    await runDst({ name: "archive-fences-hosted-publish", iterations: 12 }, async (sim) => {
      const harness = makeHarness({ hostingOrbId: ORB });
      const result = await sim.runTasks([
        {
          name: "uploader",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const orb = harness.store.orbSnapshot(ORB);
            if (orb === null || orb.runtimeTokenHash === null) return;
            const runtimeTokenHash = orb.runtimeTokenHash;
            let emitted = false;
            const uploaded = await publishHostedFile(
              task,
              harness.deps.hosting,
              {
                ...harness.hosting.request("archive-race"),
                runtimeTokenHash,
                incarnation: orb.hostIncarnation,
              },
              {
                next: () =>
                  new ResultAsync(
                    (async () => {
                      if (emitted) return ok(null);
                      emitted = true;
                      const archived = await requestOrbArchive(task, harness.deps, ORB, {
                        runtimeTokenHash,
                        hostIncarnation: orb.hostIncarnation,
                      });
                      if (archived.isErr())
                        return err({
                          type: "hosting_retryable" as const,
                          message: archived.error.message,
                        });
                      return ok(new TextEncoder().encode("alpha"));
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

  it("permanent delete supersedes an in-progress failed-compute discard", async () => {
    await runDst({ name: "delete-supersedes-discard", iterations: 30 }, async (sim) => {
      const harness = makeHarness({ constants: { deletionQuarantineMs: 2_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.appendMessage(ORB);
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
            const deleted = await requestOrbDeletion(task, harness.deps, ORB);
            expect(deleted.isOk() && deleted.value).toMatchObject({
              state: "deleting",
              hostDiscardThroughIncarnation: 0,
            });
            await waitUntil(
              task,
              "deletion-grade cleanup supersedes discard",
              () => harness.store.orbSnapshot(ORB) === null,
              { timeoutMs: 120_000 },
            );
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.world.hostCount(ORB)).toBe(0);
      expect(harness.world.filesystemExists(ORB)).toBe(false);
      expect(harness.store.replicaRecords(ORB)).toEqual([]);
    });
  });

  it("survives destroy/store failures and a control-plane restart", async () => {
    await runDst(
      {
        name: "delete-retries-after-restart",
        iterations: 30,
        failpointProbabilities: {
          [FAILPOINTS.providerDestroy]: 0.3,
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
          { name: "reconciler-1", f: (task) => reconcileLoop(task, firstDeps, stop1.signal) },
          {
            name: "reconciler-2",
            f: async (task) => {
              await waitUntil(task, "control plane restarted", () => restarted);
              await reconcileLoop(task, harness.deps, stop2.signal);
            },
          },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              while (true) {
                const snapshot = harness.store.orbSnapshot(ORB);
                if (snapshot === null || snapshot.state === "deleting") break;
                await requestOrbDeletion(task, firstDeps, ORB);
                await task.sleep(100, "retry delete request");
              }
              await task.sleep(1_000, "allow partial deletion");
              stop1.abort();
              harness = restartControlPlane(harness);
              restarted = true;
              await waitUntil(
                task,
                "deletion recovered",
                () => harness.store.orbSnapshot(ORB) === null,
                {
                  timeoutMs: 300_000,
                },
              );
              stop2.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(harness.world.hostCount(ORB)).toBe(0);
        expect(harness.world.filesystemExists(ORB)).toBe(false);
      },
    );
  });
});
