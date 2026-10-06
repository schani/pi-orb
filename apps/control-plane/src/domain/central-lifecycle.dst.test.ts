import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { LazyExecutionEnv } from "../adapters/execution-client/lazy-env.ts";
import { makeHarness, makeOrbRow, makeProjectRow, seedRunningOrb } from "../testkit/fixtures.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import type { AgentPlane } from "./agent-ports.ts";
import { awaitExecutionBinding } from "./execution-admission.ts";
import {
  reconcileCentralAgent,
  reconcileOrbOnce,
  requestOrbStart,
  requestOrbStop,
} from "./lifecycle.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

function plane(deliver: () => void, work = false): AgentPlane {
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
    deliverMessage: () => {
      deliver();
      return okAsync({
        v: 1 as const,
        messageId: "human",
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

describe("independent central lifecycle", () => {
  it("retries stopped-host unloading once work becomes quiescent without reopening or suspending", async () => {
    await runDst({ name: "central-stopped-unload", iterations: 10 }, async (sim) => {
      const h = makeHarness();
      let active = true,
        summaries = true,
        unloads = 0,
        healthCalls = 0,
        suspended = 0;
      const base = plane(() => undefined);
      const deps = {
        ...h.deps,
        agentPlane: {
          ...base,
          session: () => ({ ...base.session("orb")!, workActive: () => active }),
          health: () => {
            healthCalls++;
            return base.health({} as never, {} as never, {} as never);
          },
          suspend: () => {
            suspended++;
            return okAsync(undefined);
          },
          unload: () => {
            unloads++;
            return okAsync(!active && !summaries);
          },
        },
      };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            h.store.seedOrb(makeOrbRow("orb", "p", "stopped", { stopReason: "idle" }));
            await reconcileCentralAgent(task, deps, "orb");
            expect(unloads).toBe(0);
            active = false;
            await reconcileCentralAgent(task, deps, "orb");
            summaries = false;
            await reconcileCentralAgent(task, deps, "orb");
            expect(unloads).toBe(2);
            expect(healthCalls).toBe(1);
            expect(suspended).toBe(0);
            expect(h.store.orbSnapshot("orb")?.state).toBe("stopped");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  it("host placement never runs central admission before guest readiness", async () => {
    await runDst({ name: "host-not-central", iterations: 5 }, async (sim) => {
      const h = makeHarness();
      let calls = 0;
      const deps = {
        ...h.deps,
        agentPlane: {
          ...plane(() => calls++),
          placement: "host" as const,
          health: () => {
            calls++;
            return errAsync({
              type: "runtime_client_error" as const,
              code: "unreachable" as const,
              message: "no guest",
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
            h.store.seedOrb(makeOrbRow("orb", "p", "stopped", { stopReason: "idle" }));
            await reconcileOrbOnce(task, deps, "orb");
            expect(calls).toBe(0);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
  it("an actual lazy invocation lease defeats a stale idle observation until cleanup", async () => {
    await runDst({ name: "central-production-invocation-lease", iterations: 25 }, async (sim) => {
      const h = makeHarness();
      const deps = { ...h.deps, agentPlane: plane(() => undefined) };
      let seeded = false;
      let executing = false;
      let cleaned = false;
      let release!: () => void;
      const finish = new Promise<void>((done) => {
        release = done;
      });
      h.deps.hostProvider.executionBinding = () =>
        okAsync({ baseUrl: "http://guest", token: "private", incarnation: "0", cwd: "/tmp" });
      const result = await sim.runTasks([
        {
          name: "tool",
          f: async (task) => {
            await waitUntil(task, "seeded running execution", () => seeded);
            const env = new LazyExecutionEnv({
              cwd: "",
              acquire: (ctx) =>
                awaitExecutionBinding(task, deps, "orb", { signal: ctx.abortSignal! }, 0).map(
                  (binding) => {
                    const bound = new NodeExecutionEnv({ cwd: "/tmp" });
                    bound.exists = async () => {
                      executing = true;
                      await finish;
                      return { ok: true, value: true };
                    };
                    bound.cleanup = async () => {
                      binding.release();
                      cleaned = true;
                    };
                    return bound;
                  },
                ),
            });
            try {
              expect((await env.exists("file", BACKGROUND_CONTEXT)).ok).toBe(true);
            } finally {
              await env.cleanup(BACKGROUND_CONTEXT);
            }
          },
        },
        {
          name: "idle",
          f: async (task) => {
            seedRunningOrb(task, h, "orb");
            const row = h.store.orbSnapshot("orb")!;
            h.store.seedOrb({
              ...row,
              lastBusyAt: task.wallNow() - deps.constants.idleStopAfterMs * 2,
              stateChangedAt: task.wallNow() - deps.constants.idleStopAfterMs * 2,
            });
            seeded = true;
            await waitUntil(task, "VM invocation dispatched", () => executing);
            expect(deps.control.hasExecutionLeases("orb")).toBe(true);
            await reconcileOrbOnce(task, deps, "orb");
            expect(h.store.orbSnapshot("orb")?.state).toBe("running");
            release();
            await waitUntil(task, "VM invocation cleaned", () => cleaned);
            expect(deps.control.hasExecutionLeases("orb")).toBe(false);
            for (
              let attempt = 0;
              attempt < 15 && h.store.orbSnapshot("orb")?.state !== "stopped";
              attempt++
            ) {
              deps.control.noteRuntimeAnswered("orb", task.monotonicNow());
              await reconcileOrbOnce(task, deps, "orb");
            }
            expect(h.store.orbSnapshot("orb")?.state).toBe("stopped");
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });

  for (const accepted of [true, false]) {
    it(`hydrates guest resources before publishing running (accepted=${accepted})`, async () => {
      await runDst(
        { name: `central-resource-ready-${accepted}`, iterations: 10, lateTimerProbability: 0 },
        async (sim) => {
          const h = makeHarness();
          let adopted = 0;
          let suspends = 0;
          const central: AgentPlane = {
            ...plane(() => undefined),
            executionReady: () => {
              expect(h.store.orbSnapshot("orb")?.state).toBe("starting");
              adopted++;
              return accepted
                ? okAsync(undefined)
                : errAsync({
                    type: "runtime_client_error",
                    code: "unreachable",
                    message: "resource snapshot unavailable",
                    retryable: false,
                    answered: true,
                  });
            },
            suspend: () => {
              suspends++;
              return okAsync(undefined);
            },
          };
          const deps = { ...h.deps, agentPlane: central };
          const result = await sim.runTasks([
            {
              name: "driver",
              f: async (task) => {
                seedRunningOrb(task, h, "orb");
                h.store.seedOrb({ ...h.store.orbSnapshot("orb")!, state: "starting" });
                await reconcileOrbOnce(task, deps, "orb");
                expect(adopted).toBe(1);
                expect(h.store.orbSnapshot("orb")?.state).toBe(accepted ? "running" : "starting");
                expect(suspends).toBe(0);
                if (!accepted)
                  expect(deps.control.getBootProbe("orb")?.lastError).toBe(
                    "resource snapshot unavailable",
                  );
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    });
  }
  it("pulls central history during VM failure without overwriting guest liveness or hooks", async () => {
    await runDst({ name: "central-history-failed-vm", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      let observes = 0;
      const deps = {
        ...harness.deps,
        hostProvider: {
          ...harness.deps.hostProvider,
          observe: (...args: Parameters<typeof harness.deps.hostProvider.observe>) => {
            observes++;
            return harness.deps.hostProvider.observe(...args);
          },
        },
        agentPlane: {
          ...plane(() => undefined),
          pullHistory: () =>
            okAsync({
              v: 1 as const,
              orbId: "orb",
              runtimeInstanceId: "central",
              session: { id: "durable", overflow: {} },
              records: [],
              cursor: null,
              headId: null,
              activity: "idle" as const,
            }),
        },
      };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedOrb(makeOrbRow("orb", "p", "failed"));
            deps.control.recordPullSuccess("orb", task.monotonicNow(), "busy", "guest");
            deps.control.noteAgentWork("orb", true);
            deps.control.noteHookFailure("orb", {
              hook: "setup",
              reason: "failed",
              logPath: "/setup.log",
            });
            expect((await pollOrbUntilCaughtUp(task, deps, "orb")).type).toBe("caught_up");
            expect(harness.store.orbSnapshot("orb")?.harnessSessionId).toBe("durable");
            expect(deps.control.getLiveness("orb")?.runtimeInstanceId).toBe("guest");
            expect(deps.control.getLiveness("orb")?.activity).toBe("busy");
            expect(deps.control.getHookFailure("orb")?.logPath).toBe("/setup.log");
            expect(deps.control.hasAgentWork("orb")).toBe(true);
            expect(observes).toBe(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  for (const state of ["creating", "failed"] as const) {
    it(`delivers central input while execution is ${state}`, async () => {
      await runDst({ name: `central-delivery-${state}`, iterations: 5 }, async (sim) => {
        const harness = makeHarness();
        let delivered = 0;
        const deps = { ...harness.deps, agentPlane: plane(() => delivered++) };
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              harness.store.seedProject(makeProjectRow("p"));
              harness.store.seedOrb(makeOrbRow("orb", "p", state));
              await harness.store.enqueueOrbMessage(task, {
                orbId: "orb",
                messageId: "human",
                content: [{ type: "text", text: "hi" }],
                now: task.wallNow(),
              });
              await reconcileCentralAgent(task, deps, "orb");
              expect(delivered).toBe(1);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      });
    });
  }
  it("persists explicit Stop inhibition on an already stopped orb", async () => {
    await runDst({ name: "central-manual-stop", iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedOrb(makeOrbRow("orb", "p", "stopped", { stopReason: "idle" }));
            expect((await requestOrbStop(task, harness.deps, "orb")).isOk()).toBe(true);
            expect(harness.store.orbSnapshot("orb")?.stopReason).toBe("manual");
            expect(harness.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(1);
            expect((await requestOrbStop(task, harness.deps, "orb")).isOk()).toBe(true);
            expect(harness.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(2);
            expect((await requestOrbStart(task, harness.deps, "orb")).isOk()).toBe(true);
            expect(harness.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(3);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  for (const demand of ["visible", "work", "hidden", "grace"] as const) {
    it(`wakes stopped compute only for actual ${demand} demand`, async () => {
      await runDst({ name: `central-demand-${demand}`, iterations: 5 }, async (sim) => {
        const harness = makeHarness();
        const deps = { ...harness.deps, agentPlane: plane(() => undefined, demand === "work") };
        const result = await sim.runTasks([
          {
            name: "driver",
            f: async (task) => {
              harness.store.seedProject(makeProjectRow("p"));
              harness.store.seedOrb(
                makeOrbRow("orb", "p", "stopped", {
                  stopReason: "idle",
                  lastBusyAt: task.wallNow(),
                }),
              );
              deps.control.registerBrowserConnection("orb", "tab");
              deps.control.setBrowserVisibility("orb", "tab", demand === "visible", task.wallNow());
              await reconcileOrbOnce(task, deps, "orb");
              expect(harness.store.orbSnapshot("orb")?.state).toBe(
                demand === "visible" || demand === "work" ? "starting" : "stopped",
              );
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      });
    });
  }
  it("sleep drains and suspends an off-VM central agent without booting", async () => {
    await runDst({ name: "central-offline-sleep", iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      let suspended = 0;
      const deps = {
        ...harness.deps,
        agentPlane: {
          ...plane(() => undefined),
          prepareIdleStop: () => okAsync({ v: 1 as const, prepared: true }),
          suspend: () => {
            suspended++;
            return okAsync(undefined);
          },
        },
      };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedOrb(
              makeOrbRow("orb", "p", "failed", {
                sleepId: "sleep",
                sleepUntil: task.wallNow() + 60_000,
              }),
            );
            await reconcileOrbOnce(task, deps, "orb");
            await reconcileOrbOnce(task, deps, "orb");
            expect(harness.store.orbSnapshot("orb")?.state).toBe("stopped");
            expect(harness.store.orbSnapshot("orb")?.stopReason).toBe("sleep");
            expect(suspended).toBeGreaterThan(0);
            expect(harness.world.hostCount("orb")).toBe(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  it("persistent work and presence cannot clear a failed latch", async () => {
    await runDst({ name: "central-failed-demand", iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      const deps = { ...harness.deps, agentPlane: plane(() => undefined, true) };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            harness.store.seedOrb(makeOrbRow("orb", "p", "failed"));
            deps.control.registerBrowserConnection("orb", "tab");
            deps.control.setBrowserVisibility("orb", "tab", true, task.wallNow());
            await reconcileOrbOnce(task, deps, "orb");
            expect(harness.store.orbSnapshot("orb")?.state).toBe("failed");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  it("qualifies delayed Stop suspension against newer input while VM stopping", async () => {
    await runDst({ name: "central-stop-input-generation", iterations: 10 }, async (sim) => {
      const harness = makeHarness();
      let suspensionWaiting = false;
      let inputAccepted = false;
      let alive = false;
      harness.store.seedOrb(
        makeOrbRow("orb", "p", "stopping", { stopReason: "manual", agentAdmissionVersion: 1 }),
      );
      const centralPlane: AgentPlane = {
        ...plane(() => undefined, true),
        health: () => {
          alive = true;
          return okAsync({
            v: 1 as const,
            orbId: "orb",
            runtimeInstanceId: "central",
            status: "initializing" as const,
            phase: "booting" as const,
          });
        },
        suspend: (task, _id, _context, through) =>
          new ResultAsync(
            (async () => {
              expect(through).toBe(1);
              suspensionWaiting = true;
              await waitUntil(task, "fresh input reopened agent", () => inputAccepted);
              const row = harness.store.orbSnapshot("orb");
              if (row !== null && row.agentAdmissionVersion <= (through ?? 0)) alive = false;
              return ok(undefined);
            })(),
          ),
      };
      const deps = { ...harness.deps, agentPlane: centralPlane };
      const result = await sim.runTasks([
        {
          name: "stale-stop",
          f: async (task) => {
            await reconcileCentralAgent(task, deps, "orb");
          },
        },
        {
          name: "fresh-input",
          f: async (task) => {
            await waitUntil(task, "old stop suspension pending", () => suspensionWaiting);
            expect(
              (
                await harness.store.enqueueOrbMessage(task, {
                  orbId: "orb",
                  messageId: "new",
                  content: [{ type: "text", text: "continue" }],
                  now: task.wallNow(),
                })
              ).isOk(),
            ).toBe(true);
            expect(harness.store.orbSnapshot("orb")?.agentAdmissionVersion).toBe(2);
            await deps.agentPlane.health(task, harness.store.orbSnapshot("orb")!, {
              signal: new AbortController().signal,
            });
            inputAccepted = true;
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(alive).toBe(true);
    });
  });
  it("idle stop preserves central work and drains execution leases", async () => {
    await runDst({ name: "central-idle-lease", iterations: 5 }, async (sim) => {
      const harness = makeHarness();
      let suspends = 0;
      const deps = {
        ...harness.deps,
        agentPlane: {
          ...plane(() => undefined),
          suspend: () => {
            suspends++;
            return okAsync(undefined);
          },
        },
      };
      const result = await sim.runTasks([
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, "orb");
            const row = harness.store.orbSnapshot("orb")!;
            const release = deps.control.acquireExecutionLease("orb", row.stateVersion)!;
            harness.store.seedOrb({
              ...row,
              state: "stopping",
              stateVersion: row.stateVersion + 1,
              stopReason: "idle",
            });
            deps.control.markStopping("orb", row.stateVersion + 1);
            expect(deps.control.acquireExecutionLease("orb", row.stateVersion + 1)).toBeNull();
            await reconcileOrbOnce(task, deps, "orb");
            expect(harness.world.hostStateOf("orb")).toBe("running");
            release();
            // A never-ready execution episode needs no central-history drain.
            harness.store.seedOrb({
              ...harness.store.orbSnapshot("orb")!,
              checkoutCommit: null,
              harnessSessionId: null,
            });
            const deadline = task.wallNow() + deps.constants.createStartDeadlineMs;
            while (harness.store.orbSnapshot("orb")?.state !== "stopped") {
              expect(task.wallNow()).toBeLessThan(deadline);
              await reconcileOrbOnce(task, deps, "orb");
              await task.checkpoint("retry execution stop after bounded provider cancellation");
            }
            expect(harness.world.hostStateOf("orb")).toBe("stopped");
            expect(suspends).toBe(0);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
