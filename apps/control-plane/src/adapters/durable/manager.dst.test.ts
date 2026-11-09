import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ConditionVariable, type SimulationTask } from "determined";
import { errAsync, ResultAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { runDst } from "../../testkit/sim.ts";
import { DurableAgent } from "./agent.ts";
import { durableError, OrbAgentManager } from "./manager.ts";

const interferenceModes = ["after-baseline", "during-open"] as const;

describe.each(interferenceModes)("central manager schedules (%s)", (interference) => {
  it("drains real Harnesses across suspend, resumed incarnation and shutdown races", async () => {
    const options = { name: `durable-manager-real-lifecycle-${interference}`, iterations: 20 };
    await runDst(options, async (sim) => {
      const changed = new ConditionVariable("manager progress");
      let active = 0;
      let maximum = 0;
      let resources = 0;
      let opened = 0;
      let baselineReady = false;
      let suspended = false;
      let resuming = false;
      let shuttingDown = false;
      const manager = new OrbAgentManager<DurableAgent>({
        open: () => errAsync(durableError("explicit open required")),
        close: (agent) =>
          agent.close().map(() => {
            active--;
            return undefined;
          }),
      });
      const open = (task: SimulationTask, incarnation: number) => () => {
        if (incarnation === 2) {
          resuming = true;
          changed.notifyAll(task, "resumed open entered");
        }
        return ResultAsync.fromPromise(
          (async () => {
            await task.checkpoint(`open-${incarnation}`);
            if (incarnation === 2 && interference === "during-open")
              while (!shuttingDown) await changed.wait(task, "shutdown joins pending open");
          })(),
          () => durableError("checkpoint"),
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
      };
      const result = await sim.runTasks([
        {
          name: "original",
          f: async (task) => {
            await task.checkpoint("before-original");
            const agent = (await manager.ensure("orb", 1, open(task, 1)))._unsafeUnwrap();
            expect((await agent.appendAlert("alert", "lifecycle")).isOk()).toBe(true);
            baselineReady = true;
            changed.notifyAll(task, "baseline opened");
            await task.checkpoint("after-original");
            expect((await manager.suspend("orb")).isOk()).toBe(true);
            suspended = true;
            changed.notifyAll(task, "original suspended");
          },
        },
        {
          name: "resume",
          f: async (task) => {
            while (!(interference === "during-open" ? suspended : baselineReady))
              await changed.wait(task, "original Harness ready");
            await task.checkpoint("before-resume");
            const resumed = await manager.ensure("orb", 2, open(task, 2), true);
            if (interference === "during-open")
              expect(resumed._unsafeUnwrapErr().message).toBe("agent admission superseded");
            else if (resumed.isErr())
              expect(["agent admissions are closed", "agent admission superseded"]).toContain(
                resumed.error.message,
              );
            else expect(resumed.value).toBeInstanceOf(DurableAgent);
            await task.checkpoint("after-resume");
            expect(["agent admissions are closed", "stale agent admission authority"]).toContain(
              (await manager.ensure("orb", 1, open(task, 1)))._unsafeUnwrapErr().message,
            );
          },
        },
        {
          name: "shutdown",
          f: async (task) => {
            while (!(interference === "during-open" ? resuming : baselineReady))
              await changed.wait(task, "shutdown frontier reached");
            await task.checkpoint("before-shutdown");
            const closing = manager.close();
            shuttingDown = true;
            changed.notifyAll(task, "shutdown admitted");
            expect((await closing).isOk()).toBe(true);
            await task.checkpoint("after-shutdown");
            expect(
              (await manager.ensure("orb", 3, open(task, 3), true))._unsafeUnwrapErr().message,
            ).toBe("agent admissions are closed");
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
      expect((await manager.close()).isOk()).toBe(true);
      expect(active).toBe(0);
      expect(maximum).toBe(1);
      expect(opened).toBeGreaterThanOrEqual(interference === "during-open" ? 2 : 1);
      expect(opened).toBeLessThanOrEqual(2);
      expect(resources).toBe(opened);
      expect(manager.get("orb")).toBeNull();
    });
  });
  it("never overlaps incarnations while opening, replacing and shutting down", async () => {
    const options = { name: `durable-manager-ownership-${interference}`, iterations: 30 };
    await runDst(options, async (sim) => {
      const changed = new ConditionVariable("manager progress");
      let active = 0;
      let maximum = 0;
      const opens: number[] = [];
      let baselineReady = false;
      let replacing = false;
      let disposing = false;
      let admissionTask: import("determined").SimulationTask;
      const manager = new OrbAgentManager<{ incarnation: number }>({
        open: (_id, incarnation) =>
          ResultAsync.fromPromise(
            (async () => {
              if (incarnation === 2) {
                replacing = true;
                changed.notifyAll(admissionTask, "replacement open entered");
              }
              await admissionTask.checkpoint(`open-${incarnation}`);
              if (incarnation === 2 && interference === "during-open")
                while (!disposing) await changed.wait(admissionTask, "dispose joins pending open");
              opens.push(incarnation);
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
            expect((await manager.ensure("orb", 1))._unsafeUnwrap()).toEqual({
              incarnation: 1,
            });
            baselineReady = true;
            changed.notifyAll(task, "baseline opened");
            await task.checkpoint("after-open");
            const replacement = await manager.ensure("orb", 2);
            if (interference === "during-open")
              expect(replacement._unsafeUnwrapErr().message).toBe("agent admission superseded");
            else if (replacement.isOk()) expect(replacement.value).toEqual({ incarnation: 2 });
            else
              expect(["agent admissions are closed", "agent admission superseded"]).toContain(
                replacement.error.message,
              );
          },
        },
        {
          name: "stop",
          f: async (task) => {
            while (!(interference === "during-open" ? replacing : baselineReady))
              await changed.wait(task, "dispose frontier reached");
            await task.checkpoint("before-stop");
            const disposal = manager.dispose("orb");
            disposing = true;
            changed.notifyAll(task, "dispose admitted");
            expect((await disposal).isOk()).toBe(true);
            await task.checkpoint("after-stop");
          },
        },
      ]);
      expect(result.isErr() ? result.error : null).toBeNull();
      expect((await manager.close()).isOk()).toBe(true);
      expect(opens[0]).toBe(1);
      expect(opens.length).toBeGreaterThanOrEqual(interference === "during-open" ? 2 : 1);
      expect(opens.length).toBeLessThanOrEqual(2);
      expect(maximum).toBe(1);
      expect(active).toBe(0);
      expect(manager.get("orb")).toBeNull();
    });
  });
});
