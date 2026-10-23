import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { SimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../../testkit/sim.ts";
import { DurableAgent } from "./agent.ts";
import { durableError, OrbAgentManager } from "./manager.ts";

describe("central manager schedules", () => {
  it("drains real Harnesses across suspend, resumed incarnation and shutdown races", async () => {
    await runDst({ name: "durable-manager-real-lifecycle", iterations: 20 }, async (sim) => {
      let active = 0;
      let maximum = 0;
      let resources = 0;
      let opened = 0;
      const manager = new OrbAgentManager<DurableAgent>({
        open: () => errAsync(durableError("explicit open required")),
        close: (agent) =>
          agent.close().map(() => {
            active--;
            return undefined;
          }),
      });
      const open = (task: SimulationTask, incarnation: number) => () =>
        ResultAsync.fromPromise(task.checkpoint(`open-${incarnation}`), () =>
          durableError("checkpoint"),
        )
          .andThen(() =>
            DurableAgent.open({
              orbId: "orb",
              storage: new MemoryStorage(),
              models: createModels(),
              registry: createRegistry(),
              env: new NodeExecutionEnv({ cwd: "/tmp" }),
              checkoutCommit: "commit",
              instructions: "instruction",
              closeResources: () => {
                resources++;
                return ResultAsync.fromSafePromise(Promise.resolve());
              },
            }),
          )
          .map((agent) => {
            opened++;
            active++;
            maximum = Math.max(maximum, active);
            return agent;
          });
      const result = await sim.runTasks([
        {
          name: "original",
          f: async (task) => {
            await task.checkpoint("before-original");
            const agent = await manager.ensure("orb", 1, open(task, 1));
            await task.checkpoint("after-original");
            if (agent.isOk()) await agent.value.appendAlert("alert", "lifecycle");
            await manager.suspend("orb");
          },
        },
        {
          name: "resume",
          f: async (task) => {
            await task.checkpoint("before-resume");
            await manager.ensure("orb", 2, open(task, 2), true);
            await task.checkpoint("after-resume");
            await manager.ensure("orb", 1, open(task, 1));
          },
        },
        {
          name: "shutdown",
          f: async (task) => {
            await task.checkpoint("before-shutdown");
            await manager.close();
            await task.checkpoint("after-shutdown");
            expect((await manager.ensure("orb", 3, open(task, 3), true)).isErr()).toBe(true);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect((await manager.close()).isOk()).toBe(true);
      expect(active).toBe(0);
      expect(maximum).toBeLessThanOrEqual(1);
      expect(resources).toBe(opened);
      expect(manager.get("orb")).toBeNull();
    });
  });
  it("never overlaps incarnations while opening, replacing and shutting down", async () => {
    await runDst({ name: "durable-manager-ownership", iterations: 30 }, async (sim) => {
      let active = 0;
      let maximum = 0;
      let admissionTask: import("determined").SimulationTask;
      const manager = new OrbAgentManager<{ incarnation: number }>({
        open: (_id, incarnation) =>
          ResultAsync.fromPromise(
            (async () => {
              await admissionTask.checkpoint(`open-${incarnation}`);
              active++;
              maximum = Math.max(maximum, active);
              return { incarnation };
            })(),
            () => durableError("fake open failed"),
          ),
        close: () => {
          active--;
          return ResultAsync.fromPromise(Promise.resolve(), () =>
            durableError("fake close failed"),
          );
        },
      });
      const result = await sim.runTasks([
        {
          name: "owner",
          f: async (task) => {
            admissionTask = task;
            await task.checkpoint("before-open");
            const opened = await manager.ensure("orb", 1);
            await task.checkpoint("after-open");
            if (opened.isOk()) await manager.ensure("orb", 2);
          },
        },
        {
          name: "stop",
          f: async (task) => {
            await task.checkpoint("before-stop");
            await manager.dispose("orb");
            await task.checkpoint("after-stop");
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect((await manager.close()).isOk()).toBe(true);
      expect(maximum).toBeLessThanOrEqual(1);
      expect(active).toBe(0);
      expect(manager.get("orb")).toBeNull();
    });
  });
});

it("serializes explicit retry and abort of restart-parked work", async () => {
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { defineTask, Harness } = await import("@earendil-works/pi-durable");
  const { MemoryAgentPersistence } = await import("./memory-persistence.testkit.ts");
  await runDst({ name: "durable-parked-retry-abort", iterations: 20 }, async (sim) => {
    const authority = new MemoryAgentPersistence();
    const storage = (await authority.openOrb("parked-dst", false))._unsafeUnwrap().storage;
    let invocations = 0;
    const work = defineTask<null, { phase: "run" }, null>({
      name: "parked-race",
      version: 1,
      initial: () => ({ phase: "run" }),
      abort: (_task, runtime, context) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
      phases: {
        run: async (_task, runtime, context) => {
          invocations++;
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
        },
      },
    });
    const registry = createRegistry();
    registry.install({ name: "parked-race", tasks: [work] });
    let harness = await Harness.open(
      storage,
      { models: createModels(), registry, now: () => 1000 },
      ctx,
    );
    try {
      const root = await harness.root(ctx);
      const id = await root.commit(
        (tx) => tx.createTask(work, null, { ownership: { kind: "conversation" } }),
        ctx,
      );
      await harness.close(ctx);
      await storage.commit(
        [{ type: "task", value: { ...(await storage.task(id, ctx))!, restarts: 5 } }],
        ctx,
      );
      harness = await Harness.open(
        storage,
        { models: createModels(), registry, now: () => 1000 },
        ctx,
      );
      const result = await sim.runTasks([
        {
          name: "retry",
          f: async (task) => {
            await task.checkpoint("before-retry");
            await harness.retryTask(id, ctx);
            await task.checkpoint("after-retry");
          },
        },
        {
          name: "abort",
          f: async (task) => {
            await task.checkpoint("before-abort");
            await harness.abortTask(id, ctx);
            harness.resume();
            await task.checkpoint("after-abort");
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
      await (await harness.conversation(root.id, ctx))!.waitForIdle(ctx);
      const task = (await harness.getTask(id, ctx))!;
      expect(task.state.status).toBe("terminal");
      expect(task).not.toHaveProperty("restarts");
      expect(invocations).toBeLessThanOrEqual(1);
    } finally {
      await harness.close(ctx);
    }
  });
});
