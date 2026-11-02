import assert from "node:assert/strict";
import { UPLOAD_LEASE_MS } from "@pi-orb/protocol";
import { okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { recoverUploads, type UploadRuntime } from "./workspace-uploads.ts";

const spec = { id: "a0000000-0000-4000-8000-000000000001", name: "empty.bin", size: 0 };
const path = `/workspace/uploads/${spec.id}/${spec.name}`;
const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("workspace upload recovery authority", () => {
  it.each(["failed", "expired"] as const)(
    "does not turn replacement rebinding into an explicit retry of a %s finalization",
    async (reason) => {
      await runDst(
        { name: `state-machine-uploads-rebind-${reason}`, iterations: 1, seed: 1 },
        async (sim) => {
          const h = makeHarness();
          h.store.seedProject(makeProjectRow("project"));
          h.store.seedOrb(makeOrbRow("orb", "project", "running"));
          let finishCalls = 0;
          const runtime = {
            status: () => okAsync({ offset: 0, path: null, sha256: null }),
            finish: () => {
              finishCalls++;
              return okAsync({ offset: 0, path, sha256 });
            },
          };
          const result = await sim.runTasks([
            {
              name: "failed intent, replacement, two recovery passes",
              f: async (task) => {
                const admitted = (
                  await h.store.uploads.admit(task, "orb", spec, task.wallNow())
                )._unsafeUnwrap();
                (
                  await h.store.uploads.record(
                    task,
                    admitted,
                    {
                      status: "finalizing",
                      error: reason === "failed" ? "upload filesystem operation failed" : null,
                    },
                    task.wallNow(),
                  )
                )._unsafeUnwrap();
                if (reason === "expired")
                  await task.sleep(UPLOAD_LEASE_MS + 1, "abandoned upload lease expires");

                // The ordinary same-incarnation pass may inspect, but cannot republish.
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
                expect(finishCalls).toBe(0);
                const orb = h.store.orbSnapshot("orb");
                assert(orb !== null);
                // Replacement retains the workspace and advances its incarnation.
                h.store.seedOrb({ ...orb, hostIncarnation: orb.hostIncarnation + 1 });
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
              },
            },
          ]);
          expect(result.isOk()).toBe(true);
          expect(finishCalls, "only an explicit retry may resume failed/expired assembly").toBe(0);
          expect(h.store.messageSnapshots("orb")).toHaveLength(0);
        },
      );
    },
  );

  it.each(["failed", "expired"] as const)(
    "preserves %s admission until an explicit retry",
    async (reason) => {
      await runDst(
        { name: `state-machine-uploads-retry-${reason}`, iterations: 1, seed: 1 },
        async (sim) => {
          const h = makeHarness();
          h.store.seedProject(makeProjectRow("project"));
          h.store.seedOrb(makeOrbRow("orb", "project", "running"));
          let finishCalls = 0;
          const runtime = {
            status: () => okAsync({ offset: 0, path: null, sha256: null }),
            finish: () => {
              finishCalls++;
              return okAsync({ offset: 0, path, sha256 });
            },
          };
          const result = await sim.runTasks([
            {
              name: "background rebind then explicit retry",
              f: async (task) => {
                const admitted = (
                  await h.store.uploads.admit(task, "orb", spec, task.wallNow())
                )._unsafeUnwrap();
                const pending = (
                  await h.store.uploads.record(
                    task,
                    admitted,
                    { status: "finalizing", error: reason === "failed" ? "finish failed" : null },
                    task.wallNow(),
                  )
                )._unsafeUnwrap();
                await task.sleep(
                  reason === "expired" ? UPLOAD_LEASE_MS + 1 : 10,
                  "replacement is not activity",
                );
                const orb = h.store.orbSnapshot("orb");
                assert(orb !== null);
                h.store.seedOrb({ ...orb, hostIncarnation: orb.hostIncarnation + 1 });
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
                const rebound = (await h.store.uploads.list(task, "orb"))._unsafeUnwrap()[0];
                expect(rebound).toMatchObject({
                  incarnation: orb.hostIncarnation + 1,
                  activeUntil: pending.activeUntil,
                  error: pending.error,
                  status: "finalizing",
                });
                expect(h.store.orbSnapshot("orb")).toMatchObject({
                  uploadActiveUntil: orb.uploadActiveUntil,
                  lastBusyAt: orb.lastBusyAt,
                  stateVersion: orb.stateVersion,
                });
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
                expect(finishCalls).toBe(0);
                const retry = (
                  await h.store.uploads.admit(task, "orb", spec, task.wallNow())
                )._unsafeUnwrap();
                expect(retry.error).toBeNull();
                expect(retry.activeUntil).toBeGreaterThan(pending.activeUntil);
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
                expect(finishCalls).toBe(1);
                expect(h.store.messageSnapshots("orb")).toHaveLength(1);
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    },
  );

  it.each([false, true])(
    "resumes retained active finalization only before its original deadline (expires during status=%s)",
    async (expiresDuringStatus) => {
      await runDst(
        { name: `state-machine-uploads-active-${expiresDuringStatus}`, iterations: 1, seed: 1 },
        async (sim) => {
          const h = makeHarness();
          h.store.seedProject(makeProjectRow("project"));
          h.store.seedOrb(makeOrbRow("orb", "project", "running"));
          let finishCalls = 0;
          const result = await sim.runTasks([
            {
              name: "active intent survives replacement",
              f: async (task) => {
                const admitted = (
                  await h.store.uploads.admit(task, "orb", spec, task.wallNow())
                )._unsafeUnwrap();
                const pending = (
                  await h.store.uploads.record(
                    task,
                    admitted,
                    { status: "finalizing" },
                    task.wallNow(),
                  )
                )._unsafeUnwrap();
                const orb = h.store.orbSnapshot("orb");
                assert(orb !== null);
                h.store.seedOrb({ ...orb, hostIncarnation: orb.hostIncarnation + 1 });
                const runtime: UploadRuntime = {
                  status: (row) => {
                    expect(row).toMatchObject({
                      incarnation: orb.hostIncarnation + 1,
                      activeUntil: pending.activeUntil,
                      error: null,
                    });
                    return ResultAsync.fromSafePromise(
                      task.sleep(expiresDuringStatus ? UPLOAD_LEASE_MS + 1 : 1, "runtime status"),
                    ).map(() => ({ offset: 0, path: null, sha256: null }));
                  },
                  finish: () => {
                    finishCalls++;
                    return okAsync({ offset: 0, path, sha256 });
                  },
                };
                (await recoverUploads(task, h.store, runtime, "orb"))._unsafeUnwrap();
                expect(finishCalls).toBe(expiresDuringStatus ? 0 : 1);
                expect(h.store.messageSnapshots("orb")).toHaveLength(expiresDuringStatus ? 0 : 1);
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    },
  );

  it("still discovers retained publication after a failed expired intent is rebound", async () => {
    await runDst(
      { name: "state-machine-uploads-rebind-published", iterations: 1, seed: 1 },
      async (sim) => {
        const h = makeHarness();
        h.store.seedProject(makeProjectRow("project"));
        h.store.seedOrb(makeOrbRow("orb", "project", "running"));
        let finishCalls = 0;
        const result = await sim.runTasks([
          {
            name: "publication survived an unobserved finish response",
            f: async (task) => {
              const row = (
                await h.store.uploads.admit(task, "orb", spec, task.wallNow())
              )._unsafeUnwrap();
              (
                await h.store.uploads.record(
                  task,
                  row,
                  { status: "finalizing", error: "finish response lost" },
                  task.wallNow(),
                )
              )._unsafeUnwrap();
              await task.sleep(UPLOAD_LEASE_MS + 1, "caller disappears before replacement");
              const orb = h.store.orbSnapshot("orb");
              assert(orb !== null);
              h.store.seedOrb({ ...orb, hostIncarnation: orb.hostIncarnation + 1 });
              (
                await recoverUploads(
                  task,
                  h.store,
                  {
                    status: () => okAsync({ offset: 0, path, sha256 }),
                    finish: () => {
                      finishCalls++;
                      return okAsync({ offset: 0, path, sha256 });
                    },
                  },
                  "orb",
                )
              )._unsafeUnwrap();
              expect(finishCalls).toBe(0);
              expect((await h.store.uploads.list(task, "orb"))._unsafeUnwrap()[0]?.status).toBe(
                "notified",
              );
              expect(h.store.messageSnapshots("orb")).toHaveLength(1);
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
      },
    );
  });
});
