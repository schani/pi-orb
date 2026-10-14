import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { runDst } from "../../../testkit/sim.ts";
import {
  waitArgs as args,
  toolData as data,
  deferred,
  WaitBoundary,
  wait,
} from "./testkit/subagent-wait.ts";

it.each(["before", "acquired", "waiting"] as const)(
  "DST: every parallel child wait yields to parent steer %s acquisition/start",
  async (timing) => {
    await runDst({ name: `subagent-wait-${timing}`, iterations: 30 }, async (sim) => {
      await using boundary = await WaitBoundary.open();
      const ready = [deferred(), deferred()] as const;
      const outputs: ToolExecutionResult[] = [];
      const pending: Promise<ToolExecutionResult>[] = [];
      if (timing === "before") await boundary.queue("steer");
      if (timing === "acquired") {
        // Acquisition revision stays empty; this commit buffers before start.
        boundary.afterAcquire = async () => boundary.queue("steer");
      }
      const result = await sim.runTasks([
        ...ready.map((arrival, index) => ({
          name: `wait-${index}`,
          f: async (task: SimulationTask) => {
            const api: ToolExecutionApi = {
              ...boundary.api,
              watchDoc: (async (...parameters: Parameters<typeof boundary.api.watchDoc>) => {
                await task.checkpoint("before atomic inbox watch acquisition");
                const watch = await boundary.api.watchDoc(...parameters);
                await task.checkpoint("acquired snapshot and buffered frames before start");
                return watch;
              }) as ToolExecutionApi["watchDoc"],
              waitForTask: async (id, ctx) => {
                arrival.resolve();
                return boundary.api.waitForTask(id, ctx);
              },
            };
            const execution = wait.execute(args, api, BACKGROUND_CONTEXT);
            pending.push(execution);
            try {
              const output = await execution;
              outputs.push(output);
              expect(output.isError).not.toBe(true);
              expect(data(output)).toMatchObject({
                status: "running",
                interrupted: "parent_input",
              });
              expect(data(output)).not.toHaveProperty("receipt");
              expect(boundary.child.state.status).toBe("running");
              expect(boundary.child.abortRequested).toBe(false);
            } finally {
              arrival.resolve();
            }
          },
        })),
        {
          name: "parent",
          f: async (task: SimulationTask) => {
            if (timing === "waiting") {
              await Promise.all(ready.map((arrival) => arrival.promise));
              await task.checkpoint("both completion waiters registered before parent input");
              await boundary.queue("followUp");
              await boundary.queue("write");
              await boundary.queue("steer");
            }
          },
        },
      ]);
      boundary.complete();
      await Promise.allSettled(pending);
      expect(result.isErr() ? result.error : null).toBeNull();
      expect(outputs).toHaveLength(2);
      expect(boundary.watches.size).toBe(0);
      expect(boundary.waiters.size).toBe(0);
      expect(
        (await boundary.inbox)?.items.filter((item) => item.mode === "steer").length,
      ).toBeGreaterThan(0);
      expect(data(await wait.execute(args, boundary.api, BACKGROUND_CONTEXT))).toMatchObject({
        status: "completed",
        receipt: { result: { output: "later receipt" } },
      });
    });
  },
);

it("DST: completion races steer at the final read; caller cancellation stays distinct", async () => {
  await runDst({ name: "subagent-wait-completion-race", iterations: 100 }, async (sim) => {
    await using boundary = await WaitBoundary.open();
    const cancellation = withCancel(BACKGROUND_CONTEXT);
    const arrived = [deferred(), deferred()] as const;
    const cancelled = deferred();
    const raceReady = deferred();
    let atRead: string | undefined;
    const result = await sim.runTasks([
      {
        name: "wait",
        f: async (task: SimulationTask) => {
          const api: ToolExecutionApi = {
            ...boundary.api,
            waitForTask: async (id, ctx) => {
              arrived[0].resolve();
              return boundary.api.waitForTask(id, ctx);
            },
            getTask: async (id, ctx) => {
              await task.checkpoint("final receipt read versus terminal commit");
              const record = await boundary.api.getTask(id, ctx);
              atRead = record?.state.status;
              return record;
            },
          };
          const output = await wait.execute(args, api, BACKGROUND_CONTEXT);
          expect(output.isError).not.toBe(true);
          if (atRead === "terminal") {
            expect(data(output)).toMatchObject({
              status: "completed",
              receipt: {
                result: { output: "later receipt" },
              },
            });
            expect(data(output)).not.toHaveProperty("interrupted");
          } else {
            expect(atRead).toBe("running");
            expect(data(output)).toMatchObject({ status: "running", interrupted: "parent_input" });
            expect(data(output)).not.toHaveProperty("receipt");
          }
        },
      },
      {
        name: "cancelled-wait",
        f: async () => {
          const api: ToolExecutionApi = {
            ...boundary.api,
            waitForTask: async (id, ctx) => {
              arrived[1].resolve();
              return boundary.api.waitForTask(id, ctx);
            },
          };
          const output = await wait.execute(args, api, cancellation.context);
          expect(output.isError).toBe(true);
          expect(JSON.stringify(output)).not.toContain('"interrupted":"parent_input"');
          expect(boundary.child.state.status).toBe("running");
          expect(boundary.child.abortRequested).toBe(false);
          cancelled.resolve();
        },
      },
      {
        name: "cancel-caller",
        f: async (task: SimulationTask) => {
          await Promise.all(arrived.map((arrival) => arrival.promise));
          await task.checkpoint("cancel one observer, never its child or sibling observer");
          cancellation.cancel();
          await cancelled.promise;
          raceReady.resolve();
        },
      },
      {
        name: "complete-child",
        f: async (task: SimulationTask) => {
          await raceReady.promise;
          await task.checkpoint("child terminal commit");
          boundary.complete();
        },
      },
      {
        name: "parent-input",
        f: async (task: SimulationTask) => {
          await raceReady.promise;
          await task.checkpoint("parent steer commit");
          await boundary.queue("steer");
        },
      },
    ]);
    boundary.complete();
    expect(result.isErr() ? result.error : null).toBeNull();
    expect(boundary.watches.size).toBe(0);
    expect(boundary.waiters.size).toBe(0);
    expect(boundary.child.abortRequested).toBe(false);
    expect(data(await wait.execute(args, boundary.api, BACKGROUND_CONTEXT))).toMatchObject({
      status: "completed",
      receipt: { result: { output: "later receipt" } },
    });
  });
});
