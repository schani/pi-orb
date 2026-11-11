import { err, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  makeOrbRow,
  restartControlPlane,
  seedRunningOrb,
  TEST_USER_ID,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { publishHostedFile } from "./hosting.ts";
import {
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";

const ORB = "orb-delete";
const CHILD = "descendant-delete";

const authorityRaces = (["stop", "replacement", "discard", "archive", "delete"] as const).flatMap(
  (race) =>
    (["self", "descendant"] as const).flatMap((mode) =>
      (["archive", "delete"] as const)
        .filter((operation) => !(operation === "archive" && mode === "self" && race === "archive"))
        .map((operation) => [race, mode, operation] as const),
    ),
);

describe("orb deletion (DST)", () => {
  it.each(authorityRaces)(
    "revalidates source authority when %s wins the %s %s boundary",
    async (race, mode, operation) => {
      await runDst({ name: `${mode}-${operation}-race-${race}`, iterations: 20 }, async (sim) => {
        const harness = makeHarness();
        let intercepted = false;
        const store = new Proxy(harness.store, {
          get(target, property, receiver) {
            if (
              property === (operation === "archive" ? "requestOrbArchive" : "requestOrbDeletion")
            ) {
              return (
                task: Parameters<typeof target.requestOrbDeletion>[0],
                params: Parameters<typeof target.requestOrbDeletion>[1],
              ) =>
                new ResultAsync(
                  (async () => {
                    await task.sleep(1, "self delete before fenced write");
                    if (!intercepted) {
                      intercepted = true;
                      const current = target.orbSnapshot(ORB);
                      if (current !== null) {
                        target.seedOrb({
                          ...current,
                          stateVersion: current.stateVersion + 1,
                          ...(race === "stop"
                            ? { state: "stopping" as const }
                            : race === "archive"
                              ? { state: "archiving" as const }
                              : race === "delete"
                                ? { state: "deleting" as const }
                                : race === "discard"
                                  ? { hostDiscardThroughIncarnation: current.hostIncarnation }
                                  : {
                                      hostIncarnation: current.hostIncarnation + 1,
                                      runtimeTokenHash: "replacement-token",
                                    }),
                        });
                      }
                    }
                    return await target[
                      operation === "archive" ? "requestOrbArchive" : "requestOrbDeletion"
                    ](task, params);
                  })(),
                );
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const result = await sim.runTasks([
          {
            name: "agent",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const orb = harness.store.orbSnapshot(ORB);
              const caller = {
                runtimeTokenHash: orb?.runtimeTokenHash ?? "",
                hostIncarnation: orb?.hostIncarnation ?? -1,
              };
              if (mode === "descendant")
                (
                  await harness.store.spawnOrb(task, {
                    callerOrbId: ORB,
                    caller,
                    orb: makeOrbRow(CHILD, orb?.projectId ?? "", "creating"),
                    prompt: "work",
                    requestHash: CHILD,
                  })
                )._unsafeUnwrap();
              const requested = await (operation === "archive"
                ? requestOrbArchive
                : requestOrbDeletion)(
                task,
                { ...harness.deps, store },
                mode === "self" ? ORB : CHILD,
                mode === "self" ? caller : undefined,
                mode === "self"
                  ? undefined
                  : {
                      orbId: ORB,
                      projectId: orb?.projectId ?? "",
                      ownerUserId: TEST_USER_ID,
                      caller,
                    },
              );
              if (mode === "descendant") {
                expect(harness.store.orbSnapshot(CHILD)?.state).toBe("creating");
                expect(harness.store.deletionSnapshot(CHILD)).toBeNull();
              }
              expect(requested.isErr() && requested.error.code).toBe("conflict");
              expect(harness.store.orbSnapshot(ORB)?.state).toBe(
                race === "stop"
                  ? "stopping"
                  : race === "archive"
                    ? "archiving"
                    : race === "delete"
                      ? "deleting"
                      : "running",
              );
              expect(harness.store.deletionSnapshot(ORB)).toBeNull();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      });
    },
  );

  it.each(
    (["self", "descendant"] as const).flatMap((mode) =>
      (["archive", "delete"] as const).map((operation) => [mode, operation] as const),
    ),
  )("coalesces competing %s %s requests", async (mode, operation) => {
    const log = new LogCapture();
    await runDst(
      { name: `${mode}-${operation}-duplicates`, iterations: 30, logCapture: log },
      async (sim) => {
        const harness = makeHarness();
        let caller: { runtimeTokenHash: string; hostIncarnation: number } | undefined;
        let accepted = 0;
        const result = await sim.runTasks([
          {
            name: "seed",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const orb = harness.store.orbSnapshot(ORB);
              const authority = {
                runtimeTokenHash: orb?.runtimeTokenHash ?? "",
                hostIncarnation: orb?.hostIncarnation ?? -1,
              };
              if (mode === "descendant")
                (
                  await harness.store.spawnOrb(task, {
                    callerOrbId: ORB,
                    caller: authority,
                    orb: makeOrbRow(CHILD, orb?.projectId ?? "", "creating"),
                    prompt: "work",
                    requestHash: CHILD,
                  })
                )._unsafeUnwrap();
              caller = authority;
            },
          },
          ...["first", "second"].map((name) => ({
            name,
            f: async (task: Parameters<typeof requestOrbDeletion>[0]) => {
              await waitUntil(task, "caller ready", () => caller !== undefined);
              const requested = await (operation === "archive"
                ? requestOrbArchive
                : requestOrbDeletion)(
                task,
                harness.deps,
                mode === "self" ? ORB : CHILD,
                mode === "self" ? caller : undefined,
                mode === "self"
                  ? undefined
                  : {
                      orbId: ORB,
                      projectId: `project-of-${ORB}`,
                      ownerUserId: TEST_USER_ID,
                      caller: caller as NonNullable<typeof caller>,
                    },
              );
              if (requested.isOk()) accepted++;
              else expect(requested.error.code).toBe("conflict");
            },
          })),
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(accepted).toBe(mode === "self" && operation === "delete" ? 1 : 2);
        expect(harness.store.orbSnapshot(mode === "self" ? ORB : CHILD)?.stateVersion).toBe(1);
        expect(log.matching(`${operation}_requested`)).toHaveLength(1);
        expect(log.matching(`${operation}_requested`)[0]).toContain(`source=${mode}`);
        if (mode === "descendant")
          expect(log.matching(`${operation}_requested`)[0]).toContain(`callerOrbId=${ORB}`);
      },
    );
  });

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

  it("permanent deletion completes while racing failed-compute discard", async () => {
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
            expect(deleted.isOk()).toBe(true);
            if (deleted.isErr()) return;
            expect(deleted.value.state).toBe("deleting");
            // The concurrent reconciler may have finalized discard already.
            expect([0, null]).toContain(deleted.value.hostDiscardThroughIncarnation);
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

  it("recovers busy self-deletion after lost acknowledgement, cleanup failures, and restart", async () => {
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
        let harness = makeHarness({
          constants: { deletionQuarantineMs: 2_000, idleStopAfterMs: Number.POSITIVE_INFINITY },
          hostingOrbId: ORB,
        });
        harness.hosting.seedCompletedUpload();
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
              seedRunningOrb(task, harness, "sibling");
              harness.world.setActivity(ORB, "busy");
              const record = harness.world.appendMessage(ORB);
              const session = harness.world.sessionHeaderOf(ORB);
              expect(session).not.toBeNull();
              if (session === null) return;
              while (harness.store.replicaRecords(ORB).length === 0) {
                await harness.store.commitPullBatch(task, {
                  orbId: ORB,
                  expectedCursor: null,
                  session,
                  records: [record],
                  nextCursor: record.id,
                  nextHeadId: record.id,
                });
                await task.sleep(10, "seed replica despite store failures");
              }
              expect(harness.store.replicaRecords(ORB)).toHaveLength(1);
              const authority = harness.store.orbSnapshot(ORB);
              const caller = {
                runtimeTokenHash: authority?.runtimeTokenHash ?? "",
                hostIncarnation: authority?.hostIncarnation ?? -1,
              };
              while (true) {
                const snapshot = harness.store.orbSnapshot(ORB);
                if (snapshot === null || snapshot.state === "deleting") break;
                await requestOrbDeletion(task, firstDeps, ORB, caller);
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
        expect(harness.store.replicaRecords(ORB)).toEqual([]);
        expect(harness.hosting.ownedObjects()).toEqual([]);
        expect(harness.store.orbSnapshot("sibling")?.state).toBe("running");
        expect(harness.world.filesystemExists("sibling")).toBe(true);
      },
    );
  });
});
