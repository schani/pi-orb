import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, seedRunningOrb } from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { reconcileOrbOnce, requestOrbSleep, requestOrbStop } from "./lifecycle.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";

const ORB = "orb-sleep";

function required<T>(value: T | null | undefined, label: string): T {
  expect(value, label).toBeDefined();
  expect(value, label).not.toBeNull();
  if (value === null || value === undefined) throw new Error(label);
  return value;
}

describe("scheduled sleep lifecycle (DST)", () => {
  it("uses durable acceptance time and expires once at the exact busy boundary", async () => {
    await runDst({ name: "sleep-busy-exact-boundary", iterations: 20 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            const orb = required(harness.store.orbSnapshot(ORB), "seeded orb must exist");
            const acceptedAt = task.wallNow();
            const accepted = await requestOrbSleep(
              task,
              harness.deps,
              ORB,
              {
                runtimeTokenHash: required(
                  orb.runtimeTokenHash,
                  "running orb must have a runtime token",
                ),
                hostIncarnation: orb.hostIncarnation,
              },
              1,
              "00000000-0000-4000-8000-000000000011",
            );
            expect(accepted.isOk()).toBe(true);
            expect(accepted._unsafeUnwrap().sleepUntil).toBeGreaterThanOrEqual(acceptedAt + 1_000);
            await task.sleep(1_000, "reach exact sleep deadline");
            await reconcileOrbOnce(task, harness.deps, ORB);
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "running",
              sleepId: null,
              sleepUntil: null,
            });
            expect(
              harness.store
                .messageSnapshots(ORB)
                .filter((row) => row.system?.kind === "sleep_expired"),
            ).toHaveLength(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("duplicate reconcilers create one stopped wake", async () => {
    await runDst({ name: "sleep-due-race", iterations: 30 }, async (sim) => {
      const harness = makeHarness();
      harness.store.seedProject(makeProjectRow("project"));
      harness.store.seedOrb(
        makeOrbRow(ORB, "project", "stopped", {
          sleepId: "00000000-0000-4000-8000-000000000012",
          sleepUntil: 0,
        }),
      );
      let completed = 0;
      const due = async (task: Parameters<typeof reconcileOrbOnce>[0]) => {
        await reconcileOrbOnce(task, harness.deps, ORB);
        completed++;
      };
      const result = await sim.runTasks([
        { name: "due-a", f: due },
        { name: "due-b", f: due },
        {
          name: "driver",
          f: async (task) => {
            await waitUntil(task, "both due passes complete", () => completed === 2);
            expect(
              harness.store
                .messageSnapshots(ORB)
                .filter((row) => row.system?.kind === "sleep_wake"),
            ).toHaveLength(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("an accepted running Start cancels sleep and an old due ID cannot consume its replacement", async () => {
    await runDst({ name: "sleep-old-due-vs-replacement", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const caller = required(harness.store.orbSnapshot(ORB), "seeded orb must exist");
            const runtimeTokenHash = required(
              caller.runtimeTokenHash,
              "running orb must have a runtime token",
            );
            expect(
              (
                await requestOrbSleep(
                  task,
                  harness.deps,
                  ORB,
                  { runtimeTokenHash, hostIncarnation: caller.hostIncarnation },
                  10,
                  "00000000-0000-4000-8000-000000000015",
                )
              ).isOk(),
            ).toBe(true);
            const old = required(harness.store.orbSnapshot(ORB), "sleeping orb must exist");
            const { requestOrbStart } = await import("./lifecycle.ts");
            expect((await requestOrbStart(task, harness.deps, ORB)).isOk()).toBe(true);
            expect(
              (
                await requestOrbSleep(
                  task,
                  harness.deps,
                  ORB,
                  { runtimeTokenHash, hostIncarnation: caller.hostIncarnation },
                  20,
                  "00000000-0000-4000-8000-000000000016",
                )
              ).isOk(),
            ).toBe(true);
            await harness.store.processDueOrbSleep(task, {
              orbId: ORB,
              sleepId: required(old.sleepId, "accepted sleep must have an ID"),
              expectedStateVersion: old.stateVersion,
              now: required(old.sleepUntil, "accepted sleep must have a deadline"),
            });
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              sleepId: "00000000-0000-4000-8000-000000000016",
            });
            expect(harness.store.messageSnapshots(ORB)).toHaveLength(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("late admitted work may remain busy past the ordinary drain deadline without forced failure", async () => {
    await runDst({ name: "sleep-stopping-long-busy", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const running = required(harness.store.orbSnapshot(ORB), "seeded orb must exist");
            harness.world.setActivity(ORB, "busy");
            harness.store.seedOrb({
              ...running,
              state: "stopping",
              stateVersion: running.stateVersion + 1,
              stopReason: "sleep",
              sleepId: "00000000-0000-4000-8000-000000000017",
              sleepUntil: task.wallNow() + 1_000_000,
              stateChangedAt: task.wallNow(),
            });
            await task.sleep(
              harness.deps.constants.createStartDeadlineMs + 1,
              "busy beyond ordinary drain deadline",
            );
            await reconcileOrbOnce(task, harness.deps, ORB);
            expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopping");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("explicit Stop takes over an overdue busy sleep drain without losing final history", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "sleep-stop-override", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness({ constants: { createStartDeadlineMs: 60_000 } });
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              harness.world.setActivity(ORB, "busy");
              const running = required(harness.store.orbSnapshot(ORB), "seeded orb must exist");
              const sleepId = "00000000-0000-4000-8000-000000000027";
              const sleepAnchor = task.wallNow();
              harness.store.seedOrb({
                ...running,
                state: "stopping",
                stateVersion: running.stateVersion + 1,
                stopReason: "sleep",
                sleepId,
                sleepUntil: sleepAnchor + 1_000_000,
                stateChangedAt: sleepAnchor,
              });
              const final = harness.world.appendMessage(ORB, "final explicit-stop history");
              await task.sleep(
                harness.deps.constants.createStartDeadlineMs + 1,
                "remain busy beyond the ordinary stop deadline",
              );

              const overridden = (await requestOrbStop(task, harness.deps, ORB))._unsafeUnwrap();
              expect(overridden).toMatchObject({
                state: "stopping",
                stopReason: null,
                sleepId: null,
                sleepUntil: null,
                stateVersion: running.stateVersion + 2,
              });
              expect(overridden.stateChangedAt).toBeGreaterThan(sleepAnchor);
              const repeated = (await requestOrbStop(task, harness.deps, ORB))._unsafeUnwrap();
              expect(repeated).toMatchObject({
                stateVersion: overridden.stateVersion,
                stateChangedAt: overridden.stateChangedAt,
              });

              await waitUntil(
                task,
                "explicit stop bypasses busy sleep preparation",
                () => harness.store.orbSnapshot(ORB)?.state === "stopped",
                { timeoutMs: 20_000 },
              );
              expect(harness.store.replicaRecords(ORB).map((record) => record.id)).toContain(
                final.id,
              );
              expect(harness.world.hostStateOf(ORB)).toBe("stopped");
              expect(harness.store.orbSnapshot(ORB)).toMatchObject({
                state: "stopped",
                stopReason: null,
                sleepId: null,
                sleepUntil: null,
              });
              expect(
                harness.store
                  .messageSnapshots(ORB)
                  .filter((message) => message.system?.kind === "sleep_wake"),
              ).toEqual([]);
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    const override = capture.matching("sleep-cancelled").join("\n");
    expect(override).toContain("00000000-0000-4000-8000-000000000027");
    expect(override).toContain("override=graceful_sleep_stop");
  });

  it("finishes a sleep drain after preparation was busy beyond the create/start deadline", async () => {
    await runDst({ name: "sleep-long-busy-then-release", iterations: 20 }, async (sim) => {
      const harness = makeHarness();
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            const running = required(harness.store.orbSnapshot(ORB), "seeded orb must exist");
            harness.store.seedOrb({
              ...running,
              state: "stopping",
              stateVersion: running.stateVersion + 1,
              stopReason: "sleep",
              sleepId: "00000000-0000-4000-8000-000000000018",
              sleepUntil: task.wallNow() + 1_000_000,
              stateChangedAt: task.wallNow(),
            });
            const stopsBefore = harness.world.hostStopCountOf(ORB);
            await task.sleep(
              harness.deps.constants.createStartDeadlineMs + 1,
              "hold admitted work beyond ordinary drain deadline",
            );
            const final = harness.world.appendMessage(ORB, "final admitted history");
            harness.world.setActivity(ORB, "idle");
            await waitUntil(
              task,
              "released sleep drain stops host",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 60_000 },
            );
            expect(harness.store.replicaRecords(ORB).map((record) => record.id)).toContain(
              final.id,
            );
            expect(harness.world.hostStopCountOf(ORB)).toBe(stopsBefore + 1);
            expect(harness.world.hostStateOf(ORB)).toBe("stopped");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("bounds provider stop retries from the successful sleep preparation", async () => {
    await runDst(
      {
        name: "sleep-prepared-provider-stop-bound",
        iterations: 10,
        failpointProbabilities: { "provider.stop": 1 },
      },
      async (sim) => {
        const harness = makeHarness({ constants: { createStartDeadlineMs: 5_000 } });
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const running = required(harness.store.orbSnapshot(ORB), "running orb");
              harness.store.seedOrb({
                ...running,
                state: "stopping",
                stateVersion: running.stateVersion + 1,
                stopReason: "sleep",
                sleepId: "00000000-0000-4000-8000-000000000026",
                sleepUntil: task.wallNow() + 60_000,
                stateChangedAt: task.wallNow(),
              });
              harness.world.setActivity(ORB, "idle");
              await waitUntil(
                task,
                "prepared sleep stop fails after bounded provider retries",
                () => harness.store.orbSnapshot(ORB)?.state === "failed",
                { timeoutMs: 20_000 },
              );
              expect(harness.store.orbSnapshot(ORB)?.lastError).toContain(
                "drain_runtime_unrecoverable",
              );
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });

  it("logs a timerless graceful-stop override without inventing a cancellation identity", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "sleep-stop-timerless-override", iterations: 10, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const running = required(harness.store.orbSnapshot(ORB), "running orb");
              harness.store.seedOrb({
                ...running,
                state: "stopping",
                stateVersion: running.stateVersion + 1,
                stopReason: "sleep",
                sleepId: null,
                sleepUntil: null,
                stateChangedAt: task.wallNow(),
              });
              expect((await requestOrbStop(task, harness.deps, ORB))._unsafeUnwrap()).toMatchObject(
                {
                  state: "stopping",
                  stopReason: null,
                  stateVersion: running.stateVersion + 2,
                },
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    expect(capture.matching("override=graceful_sleep_stop")).toHaveLength(1);
    expect(capture.matching("sleep-cancelled")).toEqual([]);
  });

  it("atomically stops a running sleeper without losing its cancellation identity", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "sleep-running-stop-identity", iterations: 10, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              seedRunningOrb(task, harness, ORB);
              const running = required(harness.store.orbSnapshot(ORB), "running orb");
              harness.store.seedOrb({
                ...running,
                sleepId: "00000000-0000-4000-8000-000000000025",
                sleepUntil: task.wallNow() + 60_000,
              });
              expect((await requestOrbStop(task, harness.deps, ORB))._unsafeUnwrap()).toMatchObject(
                {
                  state: "stopping",
                  sleepId: null,
                  sleepUntil: null,
                },
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    expect(capture.matching("sleep-cancelled").join("\n")).toContain(
      "00000000-0000-4000-8000-000000000025",
    );
  });

  it("reports a failed stopped Stop cancellation and never returns stale sleep status", async () => {
    await runDst({ name: "sleep-stop-clear-failure", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedProject(makeProjectRow("project"));
            harness.store.seedOrb(
              makeOrbRow(ORB, "project", "stopped", {
                sleepId: "00000000-0000-4000-8000-000000000019",
                sleepUntil: task.wallNow() + 60_000,
              }),
            );
            harness.store.failNextClearOrbMessageAutoStart(20);
            expect((await requestOrbStop(task, harness.deps, ORB)).isErr()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)?.sleepId).not.toBeNull();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("reports an unknown committed outcome when the Stop acknowledgement is lost", async () => {
    await runDst({ name: "sleep-stop-lost-ack", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedProject(makeProjectRow("project"));
            harness.store.seedOrb(
              makeOrbRow(ORB, "project", "stopped", {
                sleepId: "00000000-0000-4000-8000-000000000024",
                sleepUntil: task.wallNow() + 60_000,
              }),
            );
            harness.store.failNextOrbStopAfterCommit(1);
            expect((await requestOrbStop(task, harness.deps, ORB)).isErr()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              state: "stopped",
              sleepId: null,
              sleepUntil: null,
            });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("returns the fresh stopped row and records the cancelled sleep identity", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "sleep-stop-fresh-cancelled-row", iterations: 10, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              harness.store.seedProject(makeProjectRow("project"));
              harness.store.seedOrb(
                makeOrbRow(ORB, "project", "stopped", {
                  sleepId: "00000000-0000-4000-8000-000000000020",
                  sleepUntil: task.wallNow() + 60_000,
                }),
              );
              const stopped = await requestOrbStop(task, harness.deps, ORB);
              expect(stopped._unsafeUnwrap()).toMatchObject({ sleepId: null, sleepUntil: null });
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    expect(capture.matching("sleep-cancelled").join("\n")).toContain(
      "00000000-0000-4000-8000-000000000020",
    );
  });

  it("preserves a due wake notice but revokes its authority and logs its sleep identity", async () => {
    const capture = new LogCapture();
    await runDst(
      { name: "sleep-stop-after-due-wake", iterations: 20, logCapture: capture },
      async (sim) => {
        const harness = makeHarness();
        const result = await sim.runTasks([
          {
            name: "due-then-stop",
            f: async (task) => {
              harness.store.seedProject(makeProjectRow("project"));
              harness.store.seedOrb(
                makeOrbRow(ORB, "project", "stopped", {
                  sleepId: "00000000-0000-4000-8000-000000000022",
                  sleepUntil: task.wallNow(),
                }),
              );
              await reconcileOrbOnce(task, harness.deps, ORB);
              await task.checkpoint("sleep wake committed before explicit stop");
              expect((await requestOrbStop(task, harness.deps, ORB)).isOk()).toBe(true);
              const notice = required(harness.store.messageSnapshots(ORB)[0], "wake notice");
              expect(notice).toMatchObject({
                messageId: "00000000-0000-4000-8000-000000000022",
                autoStart: false,
                status: "queued",
              });
              await reconcileOrbOnce(task, harness.deps, ORB);
              expect(harness.store.orbSnapshot(ORB)?.state).toBe("stopped");
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    expect(capture.matching("sleep-cancelled").join("\n")).toContain(
      "00000000-0000-4000-8000-000000000022",
    );
  });

  it("waits for accepted inbox work before sleep stop so the stopped wake is FIFO head", async () => {
    await runDst({ name: "sleep-waits-inbox-head", iterations: 20 }, async (sim) => {
      const harness = makeHarness({ constants: { idleStopAfterMs: 3_600_000 } });
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "reconciler", f: (task) => reconcileLoop(task, harness.deps, stop.signal) },
        { name: "poller", f: (task) => pollLoop(task, harness.deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            const orb = required(harness.store.orbSnapshot(ORB), "seeded orb must exist");
            await harness.store.enqueueOrbMessage(task, {
              orbId: ORB,
              messageId: "00000000-0000-4000-8000-000000000013",
              content: [{ type: "text", text: "older" }],
              now: task.wallNow(),
            });
            expect(
              (
                await requestOrbSleep(
                  task,
                  harness.deps,
                  ORB,
                  {
                    runtimeTokenHash: required(
                      orb.runtimeTokenHash,
                      "running orb must have a runtime token",
                    ),
                    hostIncarnation: orb.hostIncarnation,
                  },
                  300,
                  "00000000-0000-4000-8000-000000000014",
                )
              ).isOk(),
            ).toBe(true);
            await waitUntil(
              task,
              "older message delivered",
              () => harness.store.messageSnapshots(ORB)[0]?.status === "delivered",
              { timeoutMs: 60_000 },
            );
            harness.world.setActivity(ORB, "idle");
            await waitUntil(
              task,
              "sleep stopped",
              () => harness.store.orbSnapshot(ORB)?.state === "stopped",
              { timeoutMs: 60_000 },
            );
            await task.sleep(300_000, "reach wake deadline");
            await waitUntil(
              task,
              "sleep wake queued",
              () =>
                harness.store
                  .messageSnapshots(ORB)
                  .some((row) => row.system?.kind === "sleep_wake"),
              { timeoutMs: 60_000 },
            );
            await waitUntil(
              task,
              "wake start is authorized",
              () => {
                const state = harness.store.orbSnapshot(ORB)?.state;
                return state === "starting" || state === "running";
              },
              { timeoutMs: 60_000 },
            );
            expect(
              (
                await harness.store.readOrbBootContext(task, {
                  orbId: ORB,
                  caller: {
                    runtimeTokenHash: required(
                      harness.store.orbSnapshot(ORB)?.runtimeTokenHash,
                      "started wake must have runtime token",
                    ),
                    hostIncarnation: required(
                      harness.store.orbSnapshot(ORB),
                      "started wake orb must exist",
                    ).hostIncarnation,
                  },
                })
              )._unsafeUnwrap()?.messageId,
            ).toBe("00000000-0000-4000-8000-000000000014");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
