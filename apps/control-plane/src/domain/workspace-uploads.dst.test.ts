import assert from "node:assert/strict";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import { notifyUpload, recoverUploads, type UploadRow } from "./workspace-uploads.ts";

function required<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined, "expected fixture value");
  return value;
}

const spec = { id: "a0000000-0000-4000-8000-000000000001", name: "data.bin", size: 7 };
function setup() {
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow("orb", "project", "running"));
  return h;
}
describe("workspace upload coordination DST", () => {
  it("serializes admission against idle-stop, and protects inter-chunk gaps", async () => {
    await runDst({ name: "upload-admission-idle-stop", iterations: 60 }, async (sim) => {
      const h = setup();
      let accepted = false;
      let stopped = false;
      const version = required(h.store.orbSnapshot("orb")).stateVersion;
      const result = await sim.runTasks([
        {
          name: "upload",
          f: async (task) => {
            accepted = (await h.store.uploads.admit(task, "orb", spec, task.wallNow())).isOk();
          },
        },
        {
          name: "idle-stop",
          f: async (task) => {
            stopped = (
              await h.store.casTransition(task, {
                orbId: "orb",
                expectedStateVersion: version,
                toState: "stopping",
                stopReason: "idle",
                now: task.wallNow(),
              })
            ).isOk();
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(accepted && stopped).toBe(false);
      expect(accepted || stopped).toBe(true);
      if (accepted) {
        const check = await sim.runTasks([
          {
            name: "gap",
            f: async (task) => {
              await task.sleep(240_000, "between upload chunks");
              const orb = required(h.store.orbSnapshot("orb"));
              expect(
                (
                  await h.store.casTransition(task, {
                    orbId: "orb",
                    expectedStateVersion: orb.stateVersion,
                    toState: "stopping",
                    stopReason: "idle",
                    now: task.wallNow(),
                  })
                ).isErr(),
              ).toBe(true);
              expect(
                (
                  await h.store.casTransition(task, {
                    orbId: "orb",
                    expectedStateVersion: orb.stateVersion,
                    toState: "stopping",
                    stopReason: null,
                    now: task.wallNow(),
                  })
                ).isOk(),
              ).toBe(true);
            },
          },
        ]);
        expect(check.isOk()).toBe(true);
      }
    });
  });
  it.each([false, true])(
    "notifies one immutable batch after every member is terminal (cancel=%s)",
    async (cancelSecond) => {
      await runDst(
        { name: `upload-batch-terminal-${cancelSecond}`, iterations: 40 },
        async (sim) => {
          const h = setup();
          const second = { ...spec, id: "b0000000-0000-4000-8000-000000000002" };
          let other: UploadRow;
          let first: UploadRow;
          const initialized = await sim.runTasks([
            {
              name: "batch manifest and first publication",
              f: async (task) => {
                const rows = (
                  await h.store.uploads.createBatch(
                    task,
                    "orb",
                    { id: spec.id, files: [spec, second] },
                    task.wallNow(),
                  )
                )._unsafeUnwrap();
                first = required(rows.find((row) => row.id === spec.id));
                other = required(rows.find((row) => row.id === second.id));
                first = (
                  await h.store.uploads.record(
                    task,
                    first,
                    {
                      status: "stored",
                      offset: 7,
                      path: "/workspace/uploads/first/data.bin",
                      sha256: "a".repeat(64),
                    },
                    task.wallNow(),
                  )
                )._unsafeUnwrap();
                await notifyUpload(task, h.store, first);
                expect(h.store.messageSnapshots("orb")).toHaveLength(0);
              },
            },
          ]);
          expect(initialized.isOk()).toBe(true);
          const record = h.store.uploads.record;
          let lostMarker = false;
          h.store.uploads.record = (...args) => {
            if (args[2].status === "notified" && !lostMarker) {
              lostMarker = true;
              return errAsync({
                type: "store_error" as const,
                code: "invariant" as const,
                message: "injected crash before notification marker",
                retryable: true,
              });
            }
            return record(...args);
          };
          const completed = await sim.runTasks([
            {
              name: "second terminal outcome",
              f: async (task) => {
                other = (
                  await h.store.uploads.record(
                    task,
                    other,
                    cancelSecond
                      ? { status: "cancelled" }
                      : {
                          status: "stored",
                          offset: 7,
                          path: "/workspace/uploads/second/data.bin",
                          sha256: "b".repeat(64),
                        },
                    task.wallNow(),
                  )
                )._unsafeUnwrap();
                await notifyUpload(task, h.store, other);
              },
            },
            {
              name: "explicit stop",
              f: async (task) => {
                const orb = required((await h.store.getOrb(task, "orb"))._unsafeUnwrap());
                await h.store.casTransition(task, {
                  orbId: "orb",
                  expectedStateVersion: orb.stateVersion,
                  toState: "stopped",
                  now: task.wallNow(),
                });
              },
            },
            {
              name: "recovery overlaps completion",
              f: async (task) => {
                await recoverUploads(
                  task,
                  h.store,
                  { status: () => okAsync({ offset: 0, path: null, sha256: null }) },
                  "orb",
                );
              },
            },
          ]);
          expect(completed.isOk()).toBe(true);
          const recovered = await sim.runTasks([
            {
              name: "replay lost batch marker",
              f: async (task) => {
                await recoverUploads(
                  task,
                  h.store,
                  { status: () => okAsync({ offset: 0, path: null, sha256: null }) },
                  "orb",
                );
                await notifyUpload(task, h.store, first);
              },
            },
          ]);
          expect(recovered.isOk()).toBe(true);
          expect(lostMarker).toBe(true);
          const messages = h.store.messageSnapshots("orb");
          expect(messages).toHaveLength(1);
          expect(messages[0]?.messageId).toBe(spec.id);
          expect(messages[0]?.autoStart).toBe(false);
          const text = JSON.stringify(messages[0]?.content);
          expect(text).toContain("/workspace/uploads/first/data.bin");
          expect(text.includes("/workspace/uploads/second/data.bin")).toBe(!cancelSecond);
        },
      );
    },
  );

  it("recovers publication and lost inbox acknowledgements without duplicate messages or wake", async () => {
    await runDst({ name: "upload-publication-inbox-replay", iterations: 40 }, async (sim) => {
      const h = setup();
      let row: UploadRow;
      const init = await sim.runTasks([
        {
          name: "finalize",
          f: async (task) => {
            row = (await h.store.uploads.admit(task, "orb", spec, task.wallNow()))._unsafeUnwrap();
            row = (
              await h.store.uploads.record(
                task,
                row,
                { status: "finalizing", offset: 7 },
                task.wallNow(),
              )
            )._unsafeUnwrap();
            // Simulated disk publication outlives the caller; no success response is observed.
            await recoverUploads(
              task,
              h.store,
              {
                status: () =>
                  okAsync({
                    offset: 7,
                    path: "/workspace/uploads/data.bin",
                    sha256: "a".repeat(64),
                  }),
              },
              "orb",
            );
            row = required((await h.store.uploads.list(task, "orb"))._unsafeUnwrap()[0]);
          },
        },
      ]);
      expect(init.isOk()).toBe(true);
      expect(h.store.messageSnapshots("orb")).toHaveLength(1);
      h.store.seedOrb({ ...required(h.store.orbSnapshot("orb")), state: "stopped" });
      const result = await sim.runTasks(
        [0, 1].map((n) => ({
          name: `lost-ack-retry-${n}`,
          f: async (task) => {
            // Reconstruct the stored/pending snapshot from before the accepted inbox response.
            await notifyUpload(task, h.store, { ...row, status: "stored" });
          },
        })),
      );
      expect(result.isOk()).toBe(true);
      expect(h.store.messageSnapshots("orb")).toHaveLength(1);
      expect(h.store.messageSnapshots("orb")[0]?.autoStart).toBe(false);
      expect(h.store.orbSnapshot("orb")?.state).toBe("stopped");
    });
  });
  it("does not notify before publication and keeps same-name transfers independent", async () => {
    await runDst({ name: "upload-same-name-publication", iterations: 40 }, async (sim) => {
      const h = setup();
      const result = await sim.runTasks(
        [spec.id, "b0000000-0000-4000-8000-000000000002"].map((id) => ({
          name: id,
          f: async (task) => {
            const row = (
              await h.store.uploads.admit(task, "orb", { ...spec, id }, task.wallNow())
            )._unsafeUnwrap();
            await notifyUpload(task, h.store, row);
            const pending = (
              await h.store.uploads.record(
                task,
                row,
                { status: "finalizing", offset: 7 },
                task.wallNow(),
              )
            )._unsafeUnwrap();
            await notifyUpload(task, h.store, pending);
          },
        })),
      );
      expect(result.isOk()).toBe(true);
      expect(h.store.messageSnapshots("orb")).toHaveLength(0);
      const recovery = await sim.runTasks([
        {
          name: "recover incomplete",
          f: async (task) => {
            await recoverUploads(
              task,
              h.store,
              { status: () => okAsync({ offset: 7, path: null, sha256: null }) },
              "orb",
            );
            expect((await h.store.uploads.list(task, "orb"))._unsafeUnwrap()).toHaveLength(2);
          },
        },
      ]);
      expect(recovery.isOk()).toBe(true);
      expect(h.store.messageSnapshots("orb")).toHaveLength(0);
    });
  });

  it("Stop can win before inbox acceptance without requesting restart", async () => {
    await runDst({ name: "upload-stop-notification", iterations: 50 }, async (sim) => {
      const h = setup();
      let row: UploadRow;
      await sim.runTasks([
        {
          name: "stored",
          f: async (task) => {
            row = (await h.store.uploads.admit(task, "orb", spec, task.wallNow()))._unsafeUnwrap();
            row = (
              await h.store.uploads.record(
                task,
                row,
                { status: "stored", path: "/workspace/uploads/data.bin", offset: 7 },
                task.wallNow(),
              )
            )._unsafeUnwrap();
          },
        },
      ]);
      const result = await sim.runTasks([
        {
          name: "notify",
          f: async (task) => {
            await notifyUpload(task, h.store, row);
          },
        },
        {
          name: "stop",
          f: async (task) => {
            for (;;) {
              const orb = required((await h.store.getOrb(task, "orb"))._unsafeUnwrap());
              const stopped = await h.store.casTransition(task, {
                orbId: "orb",
                expectedStateVersion: orb.stateVersion,
                toState: "stopping",
                now: task.wallNow(),
              });
              if (stopped.isOk()) break;
            }
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(h.store.messageSnapshots("orb")[0]?.autoStart).toBe(false);
      expect(h.store.orbSnapshot("orb")?.state).toBe("stopping");
    });
  });
  it("expiry releases idle protection and stale incarnation or deletion rejects writes", async () => {
    await runDst({ name: "upload-expiry-fencing", iterations: 20 }, async (sim) => {
      const h = setup();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            const row = (
              await h.store.uploads.admit(task, "orb", spec, task.wallNow())
            )._unsafeUnwrap();
            await task.sleep(300_001, "upload abandoned");
            const orb = required(h.store.orbSnapshot("orb"));
            expect(
              (
                await h.store.casTransition(task, {
                  orbId: "orb",
                  expectedStateVersion: orb.stateVersion,
                  toState: "stopping",
                  stopReason: "idle",
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            h.store.seedOrb({ ...orb, state: "running", hostIncarnation: orb.hostIncarnation + 1 });
            expect(
              (
                await h.store.uploads.record(
                  task,
                  row,
                  { status: "stored", path: "/workspace/uploads/data.bin" },
                  task.wallNow(),
                )
              ).isErr(),
            ).toBe(true);
            h.store.seedOrb({ ...orb, state: "running" });
            const stored = (
              await h.store.uploads.record(
                task,
                row,
                { status: "stored", path: "/workspace/uploads/data.bin" },
                task.wallNow(),
              )
            )._unsafeUnwrap();
            h.store.seedOrb({ ...orb, state: "deleting" });
            expect((await h.store.uploads.admit(task, "orb", spec, task.wallNow())).isErr()).toBe(
              true,
            );
            expect((await notifyUpload(task, h.store, stored)).isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
});
