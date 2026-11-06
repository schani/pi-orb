import type { SimulationTask } from "determined";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult, submitReceipt } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it.each([false, true])(
  "schedules abort, shutdown and busy inbox admission across the SDK consume yield (held=%s)",
  async (held) => {
    await runDst({ name: `claude-stream-fairness-held-${held}`, iterations: 40 }, async (sim) => {
      let consumer: SimulationTask | null = null;
      let yielded = false;
      let armed = false;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
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
          if (!armed) return;
          yielded = true;
          await consumer?.checkpoint("SDK message yielded before query identity fence");
          if (held) await gate;
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
              armed = true;
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
              let closed = false;
              const closing = f.agent.closeExtensions().then(() => {
                closed = true;
              });
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
              await task.checkpoint("yielded consumer still blocks close after stdout EOF");
              if (held) expect(closed).toBe(false);
              release();
              await closing;
              expect((await aborted).isOk()).toBe(true);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        consumer = null;
        armed = false;
        expect(yielded).toBe(true);
        expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
        expect(Object.keys(f.state.deliveries)).toEqual(["inbox"]);
        expect(
          f.history.view.filter(
            (record) => record.type === "event" && record.eventType === "claude.operation_finished",
          ),
        ).toHaveLength(1);
        const old = f.query;
        expect(
          (
            await f.agent.deliverInboxMessage("new", ["new"], [{ type: "text", text: "hello" }])
          ).isOk(),
        ).toBe(true);
        const input = await f.query.input.next();
        if (input.done === true) throw new Error("native input ended");
        f.receipt(input.value);
        const operationId = f.agent.liveView()?.operationId;
        expect(operationId).toBeDefined();
        expect(f.queries).toHaveLength(3);
        expect(f.query).not.toBe(old);
        expect(f.agent.liveView()).toMatchObject({ operationId, blocks: [] });
        expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "busy" });
        expect(Object.keys(f.state.deliveries)).toEqual(["inbox", "new"]);
      } finally {
        release();
        consumer = null;
        f.query.exit();
        f.query.endOutput();
        await f.agent.closeExtensions();
        f.dispose();
      }
    });
  },
);
