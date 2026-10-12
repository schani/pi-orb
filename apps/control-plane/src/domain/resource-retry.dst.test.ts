import assert from "node:assert/strict";
import type { SimulationTask } from "determined";
import { err, errAsync, okAsync, ResultAsync } from "neverthrow";
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

type Harness = ReturnType<typeof makeHarness>;
const admission = 7;

function assertPresent<T>(value: T): asserts value is NonNullable<T> {
  assert(value !== null);
  assert(value !== undefined);
}

function resourceFailure(h: Harness, version = admission): void {
  h.store.seedResourceFailure("orb", version);
}

function resourceSnapshot(h: Harness): void {
  h.store.seedResourceSnapshot("orb");
}

function seedFailed(h: Harness): void {
  h.store.seedProject(makeProjectRow("p"));
  h.store.seedOrb(
    makeOrbRow("orb", "p", "failed", {
      agentAdmissionVersion: admission,
      lastError: "resource acquisition failed",
    }),
  );
}

function plane(deliver: () => void = () => undefined, work = false): AgentPlane {
  const unavailable = () =>
    errAsync({
      type: "runtime_client_error" as const,
      code: "unreachable" as const,
      message: "VM unavailable",
      retryable: true,
      answered: false,
    });
  return {
    placement: "central",
    health: () =>
      okAsync({
        v: 1 as const,
        orbId: "orb",
        runtimeInstanceId: "central",
        status: "initializing" as const,
        phase: "booting" as const,
      }),
    deliverMessage: (_task, _orb, request) => {
      deliver();
      return okAsync({
        v: 1 as const,
        messageId: request.messageId,
        status: "persisted" as const,
        delivery: "turn" as const,
        operationId: "turn",
        duplicate: false,
      });
    },
    prepareIdleStop: unavailable,
    pullHistory: unavailable,
    suspend: () => okAsync(undefined),
    dispose: () => okAsync(undefined),
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
}

async function enqueue(h: Harness, task: SimulationTask, messageId = "human", wake = true) {
  const result = await h.store.enqueueOrbMessage(task, {
    orbId: "orb",
    messageId,
    content: [{ type: "text", text: "retry" }],
    now: task.wallNow(),
    wake,
  });
  expect(result.isOk(), result.isErr() ? result.error.type : "").toBe(true);
}

describe("resource-failure retry admission", () => {
  for (const trigger of ["start", "message"] as const) {
    for (const evidence of ["current", "obsolete", "snapshot", "none"] as const) {
      it(`${trigger} renews only current resource failure without a snapshot (${evidence})`, async () => {
        await runDst(
          { name: `resource-retry-${trigger}-${evidence}`, iterations: 10 },
          async (sim) => {
            const h = makeHarness();
            seedFailed(h);
            if (evidence !== "none")
              resourceFailure(h, evidence === "obsolete" ? admission - 1 : admission);
            if (evidence === "snapshot") resourceSnapshot(h);
            const opened: number[] = [];
            const base = plane();
            const deps = {
              ...h.deps,
              agentPlane: {
                ...base,
                health: (...args: Parameters<AgentPlane["health"]>) => {
                  opened.push(args[1].agentAdmissionVersion);
                  return base.health(...args);
                },
              },
            };
            const result = await sim.runTasks([
              {
                name: "driver",
                f: async (task) => {
                  if (trigger === "start")
                    expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  else {
                    await enqueue(h, task);
                    expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission);
                    await reconcileCentralAgent(task, deps, "orb");
                  }
                  const expected = admission + (evidence === "current" ? 1 : 0);
                  expect(h.store.orbSnapshot("orb")).toMatchObject({
                    state: "starting",
                    agentAdmissionVersion: expected,
                    stopReason: null,
                    lastError: null,
                  });
                  expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  await reconcileCentralAgent(task, deps, "orb");
                  await reconcileCentralAgent(task, deps, "orb");
                  expect(opened.length).toBeGreaterThan(0);
                  expect(opened.every((version) => version === expected)).toBe(true);
                  expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(expected);
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          },
        );
      });
    }
  }

  for (const trigger of ["start", "message"] as const) {
    for (const stopReason of ["manual", "sleep"] as const) {
      it(`${trigger} combines ${stopReason} reopening and resource retry into one bump`, async () => {
        await runDst(
          { name: `resource-retry-or-${trigger}-${stopReason}`, iterations: 10 },
          async (sim) => {
            const h = makeHarness();
            seedFailed(h);
            const orb = h.store.orbSnapshot("orb");
            assertPresent(orb);
            h.store.seedOrb({
              ...orb,
              stopReason,
              ...(stopReason === "sleep"
                ? { sleepId: "sleep", sleepUntil: 1_800_000_000_000 }
                : {}),
            });
            resourceFailure(h);
            const deps = { ...h.deps, agentPlane: plane() };
            const result = await sim.runTasks([
              {
                name: "driver",
                f: async (task) => {
                  if (trigger === "start")
                    expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  else {
                    await enqueue(h, task);
                    expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 1);
                    await reconcileCentralAgent(task, deps, "orb");
                  }
                  expect(h.store.orbSnapshot("orb")).toMatchObject({
                    state: "starting",
                    agentAdmissionVersion: admission + 1,
                    stopReason: null,
                    sleepId: null,
                    sleepUntil: null,
                  });
                  await reconcileCentralAgent(task, deps, "orb");
                  expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 1);
                },
              },
            ]);
            expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          },
        );
      });
    }
  }

  it("reserves queued retry before delivery and never reuses its wake intent", async () => {
    await runDst({ name: "resource-retry-queued-one-shot", iterations: 15 }, async (sim) => {
      const h = makeHarness();
      seedFailed(h);
      resourceFailure(h);
      const deliveries: number[] = [];
      const deps = {
        ...h.deps,
        agentPlane: {
          ...plane(),
          deliverMessage: (_task: SimulationTask, orb: Parameters<AgentPlane["health"]>[1]) => {
            deliveries.push(orb.agentAdmissionVersion);
            return errAsync({
              type: "runtime_client_error" as const,
              code: "unreachable" as const,
              message: "delivery pending",
              retryable: true,
              answered: false,
            });
          },
        },
      };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            await enqueue(h, task);
            await reconcileCentralAgent(task, deps, "orb");
            expect(deliveries).toEqual([admission + 1]);
            const retried = h.store.orbSnapshot("orb");
            assertPresent(retried);
            expect(retried.state).toBe("starting");
            expect(h.store.messageSnapshots("orb")[0]?.autoStart).toBe(true);
            // New failure/version, but only the old queued wake intent.
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
            resourceFailure(h, admission + 1);
            for (let pass = 0; pass < 3; pass++) {
              await reconcileCentralAgent(task, deps, "orb");
              await reconcileOrbOnce(task, deps, "orb");
              expect(h.store.orbSnapshot("orb")).toMatchObject({
                state: "failed",
                agentAdmissionVersion: admission + 1,
              });
            }
            await enqueue(h, task, "fresh");
            await reconcileCentralAgent(task, deps, "orb");
            expect(h.store.orbSnapshot("orb")).toMatchObject({
              state: "starting",
              agentAdmissionVersion: admission + 2,
            });
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });

  for (const snapshot of [false, true]) {
    it(`VM failure preserves an active central admission (snapshot=${snapshot})`, async () => {
      await runDst({ name: `resource-retry-vm-only-${snapshot}`, iterations: 10 }, async (sim) => {
        const h = makeHarness();
        seedFailed(h);
        if (snapshot) resourceSnapshot(h);
        let deliveries = 0;
        const deps = { ...h.deps, agentPlane: plane(() => deliveries++, true) };
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              deps.control.registerBrowserConnection("orb", "tab");
              deps.control.setBrowserVisibility("orb", "tab", true, task.wallNow());
              await reconcileCentralAgent(task, deps, "orb");
              await reconcileOrbOnce(task, deps, "orb");
              expect(h.store.orbSnapshot("orb")).toMatchObject({
                state: "failed",
                agentAdmissionVersion: admission,
              });
              await enqueue(h, task);
              await reconcileCentralAgent(task, deps, "orb");
              expect(deliveries).toBe(1);
              expect(h.store.orbSnapshot("orb")).toMatchObject({
                state: "starting",
                agentAdmissionVersion: admission,
              });
              expect(deps.control.hasAgentWork("orb")).toBe(true);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      });
    });
  }

  for (const callback of ["open", "delivery"] as const) {
    it(`fences obsolete ${callback} completion after the retry bump`, async () => {
      await runDst(
        { name: `resource-retry-stale-${callback}`, iterations: 10, lateTimerProbability: 0 },
        async (sim) => {
          const h = makeHarness();
          seedFailed(h);
          resourceFailure(h);
          let waiting = false;
          let bumped = false;
          const deliveries: number[] = [];
          const base = plane();
          const deps = {
            ...h.deps,
            agentPlane: {
              ...base,
              health: (...args: Parameters<AgentPlane["health"]>) =>
                new ResultAsync(
                  (async () => {
                    if (callback === "open" && args[1].agentAdmissionVersion === admission) {
                      waiting = true;
                      await waitUntil(args[0], "retry committed", () => bumped);
                    }
                    return await base.health(...args);
                  })(),
                ),
              deliverMessage: (...args: Parameters<AgentPlane["deliverMessage"]>) =>
                new ResultAsync(
                  (async () => {
                    deliveries.push(args[1].agentAdmissionVersion);
                    if (callback === "delivery" && args[1].agentAdmissionVersion === admission) {
                      waiting = true;
                      await waitUntil(args[0], "retry committed", () => bumped);
                    }
                    return await base.deliverMessage(...args);
                  })(),
                ),
            },
          };
          const result = await sim.runTasks([
            {
              name: "obsolete-callback",
              f: async (task) => {
                // No wake: Start must be the operation that renews the episode.
                await enqueue(h, task, "human", false);
                await reconcileCentralAgent(task, deps, "orb");
                expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 1);
                expect(h.store.messageSnapshots("orb")[0]?.status).not.toBe("delivered");
                if (callback === "open") expect(deliveries).toEqual([]);
              },
            },
            {
              name: "retry",
              f: async (task) => {
                await waitUntil(task, "old callback in flight", () => waiting);
                expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 1);
                bumped = true;
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          expect(h.store.orbSnapshot("orb")?.state).toBe("starting");
        },
      );
    });
  }

  for (const winner of ["start", "stop"] as const) {
    it(`concurrent Start/Stop/wake honors the ${winner} winner without double renewal`, async () => {
      await runDst(
        { name: `resource-retry-race-${winner}`, iterations: 10, lateTimerProbability: 0 },
        async (sim) => {
          const h = makeHarness();
          seedFailed(h);
          resourceFailure(h);
          const deps = { ...h.deps, agentPlane: plane() };
          let wakeWaiting = false;
          let commandsDone = false;
          let firstDone = false;
          const wake = h.store.casStartOrbForQueuedMessage.bind(h.store);
          // Hold a stale wake CAS while commands run on independent sim tasks.
          h.store.casStartOrbForQueuedMessage = (task, params) =>
            new ResultAsync(
              (async () => {
                if (!wakeWaiting) {
                  wakeWaiting = true;
                  await waitUntil(task, "competing commands committed", () => commandsDone);
                }
                return await wake(task, params);
              })(),
            );
          const result = await sim.runTasks([
            {
              name: "wake",
              f: async (task) => {
                await enqueue(h, task);
                await reconcileCentralAgent(task, deps, "orb");
              },
            },
            {
              name: "first-command",
              f: async (task) => {
                await waitUntil(task, "wake captured old failure", () => wakeWaiting);
                if (winner === "stop") {
                  expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 1);
                } else {
                  expect((await requestOrbStop(task, deps, "orb")).isOk()).toBe(true);
                  await reconcileOrbOnce(task, deps, "orb");
                  expect(h.store.orbSnapshot("orb")?.state).toBe("stopped");
                }
                firstDone = true;
              },
            },
            {
              name: "winning-command",
              f: async (task) => {
                await waitUntil(task, "first command committed", () => firstDone);
                const command = winner === "start" ? requestOrbStart : requestOrbStop;
                expect((await command(task, deps, "orb")).isOk()).toBe(true);
                commandsDone = true;
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
          expect(h.store.orbSnapshot("orb")).toMatchObject({
            state: winner === "start" ? "starting" : "stopping",
            stopReason: winner === "start" ? null : "manual",
            agentAdmissionVersion: admission + 2,
          });
          expect(h.store.messageSnapshots("orb")[0]?.autoStart).toBe(false);
          const settled = await sim.runTasks([
            {
              name: "backstop",
              f: async (task) => {
                await reconcileCentralAgent(task, deps, "orb");
                if (winner === "stop") {
                  await reconcileOrbOnce(task, deps, "orb");
                  await reconcileCentralAgent(task, deps, "orb");
                  await reconcileOrbOnce(task, deps, "orb");
                  expect(h.store.orbSnapshot("orb")?.state).toBe("stopped");
                  expect(h.store.messageSnapshots("orb")[0]?.status).not.toBe("delivered");
                } else {
                  expect((await requestOrbStart(task, deps, "orb")).isOk()).toBe(true);
                  expect(h.store.orbSnapshot("orb")?.state).toBe("starting");
                }
                expect(h.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(admission + 2);
              },
            },
          ]);
          expect(settled.isOk(), settled.isErr() ? settled.error.message : "").toBe(true);
        },
      );
    });
  }
});
