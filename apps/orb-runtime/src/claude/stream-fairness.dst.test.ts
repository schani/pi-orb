import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult, submitReceipt } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it("schedules abort, shutdown and busy inbox admission across the SDK consume yield", async () => {
  await runDst({ name: "claude-stream-fairness", iterations: 40 }, async (sim) => {
    let consumer: SimulationTask | null = null;
    let yielded = false;
    let consumerReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      consumerReady = resolve;
    });
    let streamStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const f = new ComposedClaudeFixture(Promise.resolve(), {
      yieldMessage: async () => {
        yielded = true;
        await consumer?.checkpoint("SDK message yielded before query identity fence");
      },
    });
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const result = await sim.runTasks([
        {
          name: "sdk-consumer",
          f: async (task) => {
            consumer = task;
            consumerReady();
            await started;
            await f.agent.waitForStream();
          },
        },
        {
          name: "native-output",
          f: async (task) => {
            await ready;
            await submitReceipt(task, f);
            streamStarted();
            await f.query.emit(task, rootResult);
          },
        },
        {
          name: "abort-and-inbox",
          f: async (task) => {
            while (!yielded) await task.checkpoint("wait for consume scheduling boundary");
            await task.checkpoint("abort may race processing or query rotation");
            const query = f.query;
            const aborted = f.agent.abortOperation();
            const closing = f.agent.closeExtensions();
            expect(
              (
                await f.agent.deliverInboxMessage(
                  "busy",
                  ["busy"],
                  [{ type: "text", text: "later" }],
                )
              ).isErr(),
            ).toBe(true);
            expect(f.queries).toHaveLength(2);
            await task.checkpoint("process exit before independent stdout EOF");
            query.exit();
            await task.checkpoint("stdout EOF cannot bypass the yielded consumer");
            query.endOutput();
            await closing;
            expect((await aborted).isOk()).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(yielded).toBe(true);
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(Object.keys(f.state.deliveries)).toEqual(["inbox"]);
      expect(
        f.history.view.filter(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toHaveLength(1);
    } finally {
      consumer = null;
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      f.dispose();
    }
  });
});
