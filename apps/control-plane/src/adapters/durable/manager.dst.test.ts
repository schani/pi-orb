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
