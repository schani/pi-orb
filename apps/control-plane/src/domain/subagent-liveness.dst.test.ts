import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { PiOrbAgent, type PiSession } from "../../../orb-runtime/src/pi/agent.ts";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import {
  makeHarness,
  restartControlPlane,
  seedRunningOrb,
  TEST_CONSTANTS,
  type TestHarness,
} from "../testkit/fixtures.ts";
import { assertReplicaComplete } from "../testkit/invariants.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import { pollLoop, reconcileLoop } from "./loops.ts";
import type { OrbRuntimeClient } from "./ports.ts";

function runtime() {
  const listeners: ((event: AgentSessionEvent) => void)[] = [];
  let rootIdle = true;
  const emit = (type: "agent_start" | "agent_settled") => {
    rootIdle = type === "agent_settled";
    for (const listener of listeners) listener({ type } as AgentSessionEvent);
  };
  const session: PiSession = {
    get isIdle() {
      return rootIdle;
    },
    subscribe: (fn) => {
      listeners.push(fn);
      return () => undefined;
    },
    sendUserMessage: async () => emit("agent_start"),
    sendCustomMessage: async () => emit("agent_start"),
    abort: async () => emit("agent_settled"),
    abortBash: () => undefined,
    executeBash: async () => ({ output: "", cancelled: false, truncated: false, exitCode: 0 }),
  };
  const agent = new PiOrbAgent({
    orbId: "orb-a",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
  });
  agent.attachSession(session, SessionManager.inMemory("/unused"), {
    summarize: () => okAsync(""),
  });
  return { agent, settle: () => emit("agent_settled") };
}

function bindRuntime(harness: TestHarness, agent: PiOrbAgent) {
  const transport = harness.deps.runtimeClient;
  const runtimeClient: OrbRuntimeClient = {
    deliverMessage: (...args) => transport.deliverMessage(...args),
    health: (...args) => {
      const activity = agent.gateView().activity;
      return transport
        .health(...args)
        .map((value) => (value.status === "ready" ? { ...value, activity } : value));
    },
    pullHistory: (...args) => {
      // Capture at request acceptance, NOT response delivery: the scheduler
      // can delay an old busy/idle snapshot across a runtime transition.
      const activity = agent.gateView().activity;
      return transport.pullHistory(...args).map((value) => ({ ...value, activity }));
    },
  };
  return { ...harness.deps, runtimeClient };
}

async function watchBusy(
  task: SimulationTask,
  harness: TestHarness,
  agent: PiOrbAgent,
  windows: number,
) {
  const rounds = Math.ceil(
    (windows * TEST_CONSTANTS.idleStopAfterMs) / TEST_CONSTANTS.historyPullIntervalMs,
  );
  for (let i = 0; i < rounds; i++) {
    await task.sleep(TEST_CONSTANTS.historyPullIntervalMs, "silent leaf remains admitted");
    expect(harness.store.orbSnapshot("orb-a")?.state).toBe("running");
    expect(agent.gateView()).toMatchObject({ activity: "busy", activeOperationId: "op" });
  }
}

it("composes real runtime child ownership with pull-derived idle-stop, without a browser", async () => {
  await runDst(
    { name: "subagent-composed-idle-stop", iterations: 30, lateTimerProbability: 0 },
    async (sim) => {
      const harness = makeHarness();
      const { agent, settle } = runtime();
      await agent.submitMessage([], "op");
      const child = agent.admitSubagent("leaf")._unsafeUnwrap();
      settle();
      const deps = bindRuntime(harness, agent);
      const stop = new AbortController();
      const result = await sim.runTasks([
        { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
        { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
        {
          name: "driver",
          f: async (task) => {
            seedRunningOrb(task, harness, "orb-a");
            await watchBusy(task, harness, agent, 3);
            expect(harness.store.orbSnapshot("orb-a")?.lastBusyAt).not.toBeNull();
            agent.releaseSubagent(child);
            expect(agent.gateView().activity).toBe("idle");
            await waitUntil(
              task,
              "normal idle-stop after leaf drains",
              () => harness.store.orbSnapshot("orb-a")?.state === "stopped",
            );
            expect(harness.store.orbSnapshot("orb-a")?.stopReason).toBe("idle");
            stop.abort();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    },
  );
});

it("preserves child-only activity across control-plane restart, a wall-clock jump and failed or delayed pulls", async () => {
  await runDst(
    {
      name: "subagent-restart-clock-and-pull-failures",
      iterations: 50,
      lateTimerProbability: 0,
      failpointProbabilities: {
        [FAILPOINTS.runtimePull]: 0.03,
        [FAILPOINTS.storeCommitAfter]: 0.03,
      },
    },
    async (sim) => {
      let harness = makeHarness();
      const { agent, settle } = runtime();
      await agent.submitMessage([], "op");
      const child = agent.admitSubagent("leaf")._unsafeUnwrap();
      settle();
      let clockJump = 0;
      // A scheduled wall-clock correction must not also manufacture a network
      // outage: monotonic time, task ownership and transport deadlines stay put.
      const clock = (task: SimulationTask): SimulationTask =>
        new Proxy(task, {
          get(target, key) {
            if (key === "wallNow") return () => target.wallNow() + clockJump;
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      for (const phase of [0, 1]) {
        if (phase === 1) harness = restartControlPlane(harness);
        const deps = bindRuntime(harness, agent);
        const stop = new AbortController();
        const result = await sim.runTasks([
          { name: `poller-${phase}`, f: (task) => pollLoop(clock(task), deps, stop.signal) },
          {
            name: `reconciler-${phase}`,
            f: (task) => reconcileLoop(clock(task), deps, stop.signal),
          },
          {
            name: `driver-${phase}`,
            f: async (rawTask) => {
              const task = clock(rawTask);
              if (phase === 0) {
                seedRunningOrb(task, harness, "orb-a");
                harness.world.appendMessage("orb-a");
              }
              await waitUntil(
                task,
                "busy snapshot arrived",
                () => deps.control.getLiveness("orb-a")?.activity === "busy",
              );
              if (phase === 1) {
                await task.checkpoint("wall clock jumps with old busy snapshot in flight");
                clockJump = 8 * 3_600_000;
              }
              await watchBusy(task, harness, agent, 2);
              if (phase === 1) {
                agent.releaseSubagent(child);
                await waitUntil(
                  task,
                  "idle-stop only after child drains",
                  () => harness.store.orbSnapshot("orb-a")?.state === "stopped",
                );
              }
              stop.abort();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      }
      expect(harness.store.orbSnapshot("orb-a")?.stopReason).toBe("idle");
      assertReplicaComplete(harness.world, harness.store, "orb-a");
    },
  );
});
