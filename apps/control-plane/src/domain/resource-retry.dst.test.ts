import assert from "node:assert/strict";
import type { Simulation, SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import type { AgentPlane } from "./agent-ports.ts";
import {
  reconcileCentralAgent,
  reconcileOrbOnce,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";

const admission = 7;
const unavailable = () =>
  errAsync({
    type: "runtime_client_error" as const,
    code: "unreachable" as const,
    message: "VM unavailable",
    retryable: true,
    answered: false,
  });

function retryHarness(resourceFailed = true, work = false) {
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("p"));
  h.store.seedOrb(
    makeOrbRow("orb", "p", "failed", {
      agentAdmissionVersion: admission,
      lastError: "resource acquisition failed",
    }),
  );
  if (resourceFailed) h.store.seedResourceFailure("orb", admission);
  const calls = { deliveries: [] as number[], suspensions: [] as number[], disposals: 0 };
  const agentPlane: AgentPlane = {
    placement: "central",
    health: () =>
      okAsync({
        v: 1,
        orbId: "orb",
        runtimeInstanceId: "central",
        status: "initializing",
        phase: "booting",
      }),
    deliverMessages: (_task, orb, requests) => {
      const request = requests[0]!;
      calls.deliveries.push(orb.agentAdmissionVersion);
      return okAsync([
        ok({
          v: 1,
          messageId: request.messageId,
          status: "persisted",
          delivery: "turn",
          operationId: "turn",
          duplicate: false,
        }),
      ]);
    },
    prepareIdleStop: unavailable,
    pullHistory: unavailable,
    suspend: (_task, _orbId, _context, through) => {
      calls.suspensions.push(through ?? -1);
      return okAsync(undefined);
    },
    dispose: () => {
      calls.disposals++;
      return okAsync(undefined);
    },
    session: () => ({
      runtimeInstanceId: "central",
      workActive: () => work,
      snapshot: () => err({ message: "not projected" }),
      liveView: () => null,
      subscribe: () => () => undefined,
      request: unavailable,
    }),
    close: () => okAsync(undefined),
  };
  return { ...h, deps: { ...h.deps, agentPlane }, calls };
}

function dst(name: string, tasks: () => Parameters<Simulation["runTasks"]>[0]) {
  return runDst({ name, iterations: 15, lateTimerProbability: 0 }, async (sim) => {
    const result = await sim.runTasks(tasks());
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
  });
}

async function enqueue(
  h: ReturnType<typeof retryHarness>,
  task: SimulationTask,
  id = "human",
  wake = true,
) {
  const result = await h.store.enqueueOrbMessage(task, {
    orbId: "orb",
    messageId: id,
    content: [{ type: "text", text: "retry" }],
    now: task.wallNow(),
    wake,
  });
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe("resource-failure retry admission", () => {
  it("compute-only failure preserves active central admission without revocation", async () => {
    await dst("resource-retry-vm-only", () => {
      const h = retryHarness(false, true);
      return [
        {
          name: "driver",
          f: async (task) => {
            h.deps.control.registerBrowserConnection("orb", "tab");
            h.deps.control.setBrowserVisibility("orb", "tab", true, task.wallNow());
            await reconcileCentralAgent(task, h.deps, "orb");
            await reconcileOrbOnce(task, h.deps, "orb");
            expect(h.store.orbSnapshot("orb")).toMatchObject({
              state: "failed",
              agentAdmissionVersion: admission,
            });
            await enqueue(h, task);
            await reconcileCentralAgent(task, h.deps, "orb");
            expect(h.calls.deliveries).toEqual([admission]);
            expect(h.store.orbSnapshot("orb")).toMatchObject({
              state: "starting",
              agentAdmissionVersion: admission,
            });
            expect(h.deps.control.hasAgentWork("orb")).toBe(true);
            expect(h.calls.suspensions).toEqual([]);
            expect(h.calls.disposals).toBe(0);
          },
        },
      ];
    });
  });

  it("queued retry is one-shot, including duplicate admission of its existing inbox row", async () => {
    await dst("resource-retry-queued-one-shot", () => {
      const h = retryHarness();
      h.deps.agentPlane.deliverMessages = (_task, orb) => {
        h.calls.deliveries.push(orb.agentAdmissionVersion);
        return unavailable();
      };
      return [
        {
          name: "driver",
          f: async (task) => {
            await enqueue(h, task);
            await reconcileCentralAgent(task, h.deps, "orb");
            expect(h.calls.deliveries).toEqual([admission + 1]);
            const retried = h.store.orbSnapshot("orb");
            assert(retried);
            expect(retried.state).toBe("starting");
            expect(h.store.messageSnapshots("orb")[0]?.autoStart).toBe(true);
            expect(
              (
                await h.store.casTransition(task, {
                  orbId: "orb",
                  expectedStateVersion: retried.stateVersion,
                  toState: "failed",
                  lastError: "retry failed",
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            h.store.seedResourceFailure("orb", admission + 1);
            const inbox = h.store.messageSnapshots("orb");
            const duplicate = await enqueue(h, task);
            expect(duplicate.duplicate).toBe(true);
            expect(h.store.messageSnapshots("orb")).toEqual(inbox);
            for (let pass = 0; pass < 3; pass++) {
              await reconcileCentralAgent(task, h.deps, "orb");
              await reconcileOrbOnce(task, h.deps, "orb");
              expect(h.store.orbSnapshot("orb")).toMatchObject({
                state: "failed",
                agentAdmissionVersion: admission + 1,
              });
            }
            await enqueue(h, task, "fresh");
            await reconcileCentralAgent(task, h.deps, "orb");
            expect(h.store.orbSnapshot("orb")).toMatchObject({
              state: "starting",
              agentAdmissionVersion: admission + 2,
            });
          },
        },
      ];
    });
  });

  for (const callback of ["open", "delivery"] as const) {
    for (const winner of ["start", "stop"] as const) {
      it(
        callback === "delivery"
          ? `late accepted receipt leaves ${winner} command authoritative`
          : `late open completion is fenced by ${winner}`,
        async () => {
          await dst(`resource-retry-stale-${callback}-${winner}`, () => {
            const h = retryHarness();
            let waiting = false;
            let committed = false;
            const completions: number[] = [];
            const block = async (task: SimulationTask, version: number) => {
              if (version !== admission) return;
              waiting = true;
              await waitUntil(task, "winning command committed", () => committed);
            };
            const base = { ...h.deps.agentPlane };
            h.deps.agentPlane.health = (...args) =>
              new ResultAsync(
                (async () => {
                  if (callback === "open") await block(args[0], args[1].agentAdmissionVersion);
                  const result = await base.health(...args);
                  if (callback === "open") completions.push(args[1].agentAdmissionVersion);
                  return result;
                })(),
              );
            h.deps.agentPlane.deliverMessages = (...args) =>
              new ResultAsync(
                (async () => {
                  const result = await base.deliverMessages(...args);
                  if (callback === "delivery") await block(args[0], args[1].agentAdmissionVersion);
                  if (callback === "delivery") completions.push(args[1].agentAdmissionVersion);
                  return result;
                })(),
              );
            return [
              {
                name: "obsolete-callback",
                f: async (task) => {
                  await enqueue(h, task, "human", false);
                  await reconcileCentralAgent(task, h.deps, "orb");
                  expect(h.store.orbSnapshot("orb")).toMatchObject({
                    state: winner === "start" ? "starting" : "stopped",
                    agentAdmissionVersion: admission + 1,
                    stopReason: winner === "start" ? null : "manual",
                  });
                  const after = h.store.messageSnapshots("orb")[0];
                  expect(after).toMatchObject({
                    orbId: "orb",
                    messageId: "human",
                    deliveryBatchId: "human",
                    status: "delivering",
                    delivery: callback === "delivery" ? "turn" : null,
                    operationId: callback === "delivery" ? "turn" : null,
                  });
                  expect(completions).toEqual([admission]);
                  expect(h.calls.deliveries).toEqual(callback === "open" ? [] : [admission]);
                },
              },
              {
                name: "winning-command",
                f: async (task) => {
                  await waitUntil(task, "old callback in flight", () => waiting);
                  const command = winner === "start" ? requestOrbStart : requestOrbStop;
                  expect((await command(task, h.deps, "orb")).isOk()).toBe(true);
                  if (winner === "stop") await reconcileOrbOnce(task, h.deps, "orb");
                  expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 1);
                  committed = true;
                },
              },
            ];
          });
        },
      );
    }
  }

  for (const winner of ["start", "stop"] as const) {
    it(`stale queued wake CAS cannot undo the ${winner} command winner`, async () => {
      await dst(`resource-retry-race-${winner}`, () => {
        const h = retryHarness();
        let wakeWaiting = false;
        let commandsDone = false;
        const wake = h.store.casStartOrbForQueuedMessage.bind(h.store);
        h.store.casStartOrbForQueuedMessage = (task, params) =>
          new ResultAsync(
            (async () => {
              wakeWaiting = true;
              await waitUntil(task, "competing commands committed", () => commandsDone);
              const result = await wake(task, params);
              expect(result.isErr() && result.error.type).toBe("state_conflict");
              return result;
            })(),
          );
        return [
          {
            name: "stale-wake",
            f: async (task) => {
              await enqueue(h, task);
              await reconcileCentralAgent(task, h.deps, "orb");
              expect(h.store.orbSnapshot("orb")).toMatchObject({
                state: winner === "start" ? "starting" : "stopping",
                stopReason: winner === "start" ? null : "manual",
                agentAdmissionVersion: admission + 2,
              });
              expect(h.store.messageSnapshots("orb")[0]?.autoStart).toBe(false);
              await reconcileCentralAgent(task, h.deps, "orb");
              if (winner === "stop") {
                await reconcileOrbOnce(task, h.deps, "orb");
                expect(h.store.orbSnapshot("orb")?.state).toBe("stopped");
                expect(h.store.messageSnapshots("orb")[0]).toMatchObject({
                  status: "queued",
                  delivery: null,
                  operationId: null,
                });
              } else {
                expect((await requestOrbStart(task, h.deps, "orb")).isOk()).toBe(true);
              }
              expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 2);
            },
          },
          {
            name: "commands",
            f: async (task) => {
              await waitUntil(task, "wake captured old failure", () => wakeWaiting);
              const first = winner === "stop" ? requestOrbStart : requestOrbStop;
              expect((await first(task, h.deps, "orb")).isOk()).toBe(true);
              if (winner === "start") await reconcileOrbOnce(task, h.deps, "orb");
              const last = winner === "start" ? requestOrbStart : requestOrbStop;
              expect((await last(task, h.deps, "orb")).isOk()).toBe(true);
              commandsDone = true;
            },
          },
        ];
      });
    });
  }
});
