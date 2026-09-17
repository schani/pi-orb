import type { SimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  restartControlPlane,
  seedRunningOrb,
  TEST_CONSTANTS,
} from "../testkit/fixtures.ts";
import { LogCapture, runDst, waitUntil } from "../testkit/sim.ts";
import { ControlState } from "./control-state.ts";
import {
  enqueueOrbMessage,
  reconcileOrbOnce,
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbSleep,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import { reconcileLoop } from "./loops.ts";
import type { ControlPlaneDeps, ControlPlaneStore } from "./ports.ts";
import { notifyUpload } from "./workspace-uploads.ts";

const ORB = "orb-sleep-matrix";
const SLEEP = "00000000-0000-4000-8000-000000000071";

function required<T>(value: T | null | undefined, label: string): T {
  expect(value, label).toBeDefined();
  expect(value, label).not.toBeNull();
  if (value === null || value === undefined) throw new Error(label);
  return value;
}

function caller(store: {
  orbSnapshot(id: string): ReturnType<ReturnType<typeof makeHarness>["store"]["orbSnapshot"]>;
}) {
  const orb = required(store.orbSnapshot(ORB), "seeded orb");
  return {
    runtimeTokenHash: required(orb.runtimeTokenHash, "runtime token"),
    hostIncarnation: orb.hostIncarnation,
  };
}

/** Gate immediately before or after the real store transaction, never at an arbitrary timer. */
function gateDueTransaction(
  store: ControlPlaneStore,
  side: "before" | "after",
  state: { reached: boolean; release: boolean },
): ControlPlaneStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "processDueOrbSleep") {
        return (
          task: SimulationTask,
          params: Parameters<ControlPlaneStore["processDueOrbSleep"]>[1],
        ) =>
          new ResultAsync(
            (async () => {
              if (side === "before") {
                state.reached = true;
                await waitUntil(
                  task,
                  "release due transaction before commit",
                  () => state.release,
                  {
                    intervalMs: 1,
                  },
                );
              }
              const result = await target.processDueOrbSleep(task, params);
              if (side === "after") {
                state.reached = true;
                await waitUntil(task, "release due transaction after commit", () => state.release, {
                  intervalMs: 1,
                });
              }
              return result;
            })(),
          );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function acceptSleep(task: SimulationTask, deps: ControlPlaneDeps, durationSeconds = 1) {
  const accepted = await requestOrbSleep(
    task,
    deps,
    ORB,
    caller(deps.store as ReturnType<typeof makeHarness>["store"]),
    durationSeconds,
    SLEEP,
  );
  expect(accepted.isOk(), accepted.isErr() ? accepted.error.message : "").toBe(true);
  return accepted._unsafeUnwrap();
}

describe("scheduled sleep qualification matrix (DST)", () => {
  it("recovers future and overdue sleeps across fresh control state and both due-commit crash windows", async () => {
    await runDst({ name: "sleep-matrix-restart-due-transaction", iterations: 20 }, async (sim) => {
      const harness = makeHarness({
        constants: { idleStopAfterMs: 3_600_000 },
      });
      const before = { reached: false, release: false };
      const after = { reached: false, release: false };
      let dueReady = false;
      let preDone = false;
      let postDone = false;
      let preDeps: ControlPlaneDeps | null = null;
      let postDeps: ControlPlaneDeps | null = null;
      const result = await sim.runTasks([
        {
          name: "pre-commit reconciler",
          f: async (task) => {
            await waitUntil(task, "overdue sleep and pre-commit role ready", () => {
              return dueReady && preDeps !== null;
            });
            await reconcileOrbOnce(task, required(preDeps, "pre-commit deps"), ORB);
            preDone = true;
          },
        },
        {
          name: "post-commit reconciler",
          f: async (task) => {
            await waitUntil(task, "pre-commit transaction blocked", () => {
              return before.reached && postDeps !== null;
            });
            await reconcileOrbOnce(task, required(postDeps, "post-commit deps"), ORB);
            postDone = true;
          },
        },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            const accepted = await acceptSleep(task, harness.deps, 300);

            const future = restartControlPlane(harness);
            await reconcileOrbOnce(task, future.deps, ORB);
            expect(harness.store.orbSnapshot(ORB)?.sleepId).toBe(SLEEP);
            await task.sleep(
              Math.max(0, accepted.sleepUntil - task.wallNow()),
              "control plane is down until due",
            );

            const beforeCrash = restartControlPlane(future);
            preDeps = {
              ...beforeCrash.deps,
              store: gateDueTransaction(harness.store, "before", before),
            };
            const afterCrash = restartControlPlane(beforeCrash);
            postDeps = {
              ...afterCrash.deps,
              store: gateDueTransaction(harness.store, "after", after),
            };
            dueReady = true;
            await waitUntil(task, "fresh process committed due transaction", () => after.reached);
            expect(harness.store.orbSnapshot(ORB)).toMatchObject({
              sleepId: null,
              sleepUntil: null,
            });

            // Crash after commit: another fresh process observes the committed singleton.
            const committedRecovery = restartControlPlane(afterCrash);
            await reconcileOrbOnce(task, committedRecovery.deps, ORB);
            before.release = true;
            after.release = true;
            await waitUntil(task, "stranded actors released", () => preDone && postDone);
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

  for (const winner of ["command", "due"] as const) {
    for (const command of ["start", "stop", "message", "archive", "delete"] as const) {
      it(`${winner} linearizes first when ${command} races a due sleep`, async () => {
        await runDst(
          {
            name: `sleep-matrix-${command}-${winner}-first`,
            iterations: 8,
            lateTimerProbability: 0,
          },
          async (sim) => {
            const harness = makeHarness({
              constants: { idleStopAfterMs: 3_600_000 },
            });
            const gate = { reached: false, release: winner === "due" };
            let deadlineReached = false;
            let dueDone = false;
            const dueDeps = {
              ...harness.deps,
              control: new ControlState(),
              store: gateDueTransaction(harness.store, "before", gate),
            };
            const result = await sim.runTasks([
              {
                name: "due",
                f: async (task) => {
                  await waitUntil(task, "sleep deadline reached", () => deadlineReached, {
                    intervalMs: 1,
                  });
                  await reconcileOrbOnce(task, dueDeps, ORB);
                  dueDone = true;
                },
              },
              {
                name: "command",
                f: async (task) => {
                  seedRunningOrb(task, harness, ORB);
                  harness.world.setActivity(ORB, "busy");
                  const accepted = await acceptSleep(task, harness.deps);
                  await task.sleep(
                    Math.max(0, accepted.sleepUntil - task.wallNow()),
                    "reach exact sleep deadline",
                  );
                  deadlineReached = true;
                  await waitUntil(task, "due transaction boundary", () => gate.reached, {
                    intervalMs: 1,
                  });
                  if (winner === "due")
                    await waitUntil(task, "due committed", () => dueDone, {
                      intervalMs: 1,
                    });

                  const outcome =
                    command === "start"
                      ? await requestOrbStart(task, harness.deps, ORB)
                      : command === "stop"
                        ? await requestOrbStop(task, harness.deps, ORB)
                        : command === "message"
                          ? await enqueueOrbMessage(task, harness.deps, {
                              orbId: ORB,
                              messageId: "00000000-0000-4000-8000-000000000072",
                              content: [{ type: "text", text: "human wins atomically" }],
                            })
                          : command === "archive"
                            ? await requestOrbArchive(task, harness.deps, ORB)
                            : await requestOrbDeletion(task, harness.deps, ORB);
                  expect(outcome.isOk()).toBe(true);
                  gate.release = true;
                  await waitUntil(task, "due pass complete", () => dueDone, {
                    intervalMs: 1,
                  });

                  const notices = harness.store
                    .messageSnapshots(ORB)
                    .filter((row) => row.system?.kind === "sleep_expired");
                  expect(notices).toHaveLength(winner === "due" ? 1 : 0);
                  expect(harness.store.orbSnapshot(ORB)?.sleepId).toBeNull();
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          },
        );
      });
    }
  }

  it("rejected Start while stopping retains the schedule", async () => {
    await runDst({ name: "sleep-matrix-rejected-start", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            await acceptSleep(task, harness.deps, 300);
            const row = required(harness.store.orbSnapshot(ORB), "sleeping orb");
            harness.store.seedOrb({
              ...row,
              state: "stopping",
              stateVersion: row.stateVersion + 1,
              stopReason: "sleep",
            });
            expect((await requestOrbStart(task, harness.deps, ORB)).isErr()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)?.sleepId).toBe(SLEEP);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("late system and upload notices cannot cancel a replacement sleep", async () => {
    await runDst({ name: "sleep-matrix-internal-notices", iterations: 12 }, async (sim) => {
      const harness = makeHarness({
        constants: { idleStopAfterMs: 3_600_000 },
      });
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, ORB);
            harness.world.setActivity(ORB, "busy");
            await acceptSleep(task, harness.deps);
            await task.sleep(1_000, "expire old sleep");
            await reconcileOrbOnce(task, harness.deps, ORB);
            expect(
              harness.store
                .messageSnapshots(ORB)
                .some((row) => row.system?.kind === "sleep_expired"),
            ).toBe(true);

            const upload = (
              await harness.store.uploads.admit(
                task,
                ORB,
                {
                  id: "00000000-0000-4000-8000-000000000073",
                  name: "late.txt",
                  size: 4,
                },
                task.wallNow(),
              )
            )._unsafeUnwrap();
            const replacement = "00000000-0000-4000-8000-000000000074";
            const accepted = await requestOrbSleep(
              task,
              harness.deps,
              ORB,
              caller(harness.store),
              300,
              replacement,
            );
            expect(accepted.isOk()).toBe(true);
            const stored = (
              await harness.store.uploads.record(
                task,
                upload,
                {
                  status: "stored",
                  offset: 4,
                  path: "/workspace/uploads/late.txt",
                  sha256: "a".repeat(64),
                },
                task.wallNow(),
              )
            )._unsafeUnwrap();
            expect((await notifyUpload(task, harness.store, stored)).isOk()).toBe(true);
            expect(harness.store.orbSnapshot(ORB)?.sleepId).toBe(replacement);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  it("a sleep wake boot failure spends one automatic attempt and manual recovery keeps its notice", async () => {
    const capture = new LogCapture();
    await runDst(
      {
        name: "sleep-matrix-wake-one-shot",
        iterations: 8,
        logCapture: capture,
      },
      async (sim) => {
        const harness = makeHarness({
          constants: { idleStopAfterMs: 3_600_000 },
        });
        const stop = new AbortController();
        const wakes = () => capture.matching("to=starting reason=queued_message").length;
        const result = await sim.runTasks([
          {
            name: "reconciler",
            f: (task) => reconcileLoop(task, harness.deps, stop.signal),
          },
          {
            name: "driver",
            f: async (task) => {
              harness.world.configureOrb(ORB, {
                initDurationMs: 0,
                initOutcome: "failed_nonretryable",
              });
              harness.store.seedProject(makeProjectRow("project"));
              harness.store.seedOrb(
                makeOrbRow(ORB, "project", "failed", {
                  sleepId: SLEEP,
                  sleepUntil: task.wallNow(),
                }),
              );
              await waitUntil(
                task,
                "scheduled wake boot fails",
                () => harness.store.orbSnapshot(ORB)?.state === "failed" && wakes() === 1,
                { timeoutMs: 600_000 },
              );
              for (let round = 0; round < 4; round++) {
                await task.sleep(
                  TEST_CONSTANTS.hostBackstopIntervalMs,
                  "repeat terminal reconciliation",
                );
                expect(wakes()).toBe(1);
              }
              expect(
                harness.store.messageSnapshots(ORB).find((row) => row.messageId === SLEEP)?.status,
              ).toBe("queued");
              harness.world.configureOrb(ORB, {
                initDurationMs: 0,
                initOutcome: "ready",
              });
              expect((await requestOrbStart(task, harness.deps, ORB)).isOk()).toBe(true);
              await waitUntil(
                task,
                "manual recovery running",
                () => harness.store.orbSnapshot(ORB)?.state === "running",
                { timeoutMs: 600_000 },
              );
              expect(
                harness.store.messageSnapshots(ORB).find((row) => row.messageId === SLEEP),
              ).toMatchObject({
                system: { kind: "sleep_wake" },
                status: "queued",
              });
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
  });
});
