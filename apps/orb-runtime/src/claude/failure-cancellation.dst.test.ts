import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import {
  background,
  ComposedClaudeFixture,
  childEdge,
  rootRequest,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

const failure = {
  ...rootResult,
  uuid: "failed-result",
  is_error: true,
  stop_reason: "stop_sequence",
  api_error_status: 429,
  result: "API error",
} as unknown as SDKMessage;
const acknowledgment = {
  ...rootResult,
  uuid: "command-ack",
  num_turns: 0,
  stop_reason: null,
  result: "",
} as unknown as SDKMessage;

it("cancels a failed result before late task notifications and acknowledgments can strand handoffs", async () => {
  await runDst({ name: "claude-failed-result-handoff", iterations: 20 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    let produced = false;
    try {
      expect((await f.attach()).isOk()).toBe(true);
      const scheduled = await sim.runTasks([
        {
          name: "native-output",
          f: async (task) => {
            await submitReceipt(task, f);
            f.query.interruptReceipt = { still_queued: [], cancelled: [] };
            const cancelled = vi.spyOn(f.query, "interrupt");
            await f.query.emit(task, childEdge("task_started"));
            await f.query.emit(task, background([{ task_id: "child", description: "child" }]));
            await f.query.emit(task, failure);
            await f.query.emit(task, childEdge("task_notification"));
            await f.query.emit(task, background([]));
            await f.query.emit(task, acknowledgment);
            produced = true;
            await task.checkpoint("failed turn and trailing task output consumed before exit");
            expect(cancelled).toHaveBeenCalledTimes(1);
            expect(cancelled).toHaveBeenCalledWith({ cancelQueued: true });
            expect(f.query.closeRequested).toBe(true);
            expect(f.agent.gateView().activity).toBe("busy");
            expect(f.agent.prepareIdleStop().unwrapOr(false)).toBe(false);
            expect(
              (
                await f.agent.deliverInboxMessage(
                  "late",
                  ["late"],
                  [{ type: "text", text: "late" }],
                )
              ).isErr(),
            ).toBe(true);
            f.query.endOutput();
          },
        },
        {
          name: "supervisor",
          f: async (task) => {
            while (!produced) await task.sleep(1, "wait for failed-turn task terminals");
            await task.checkpoint("native exit independent of stdout EOF");
            f.query.exit();
            await f.agent.closeExtensions();
          },
        },
      ]);
      expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
      expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      expect(f.journal().pendingHandoffs).toEqual({});
      expect(f.journal().ownedTasks).toEqual({});
      expect(f.journal().ownedBackgroundTasks).toEqual({});
      expect(
        f.history.view.filter(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toMatchObject([{ overflow: { outcome: "failed" } }]);
      expect(
        f.history.view.filter(
          (record) => record.type === "event" && record.eventType === "claude.handoff_interrupted",
        ),
      ).toMatchObject([
        {
          overflow: {
            taskId: "child",
            reason: "failed_result",
            resultId: "failed-result",
            automaticReplay: false,
          },
        },
      ]);
    } finally {
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      f.dispose();
    }
  });
});

it.each(["before", "after"] as const)(
  "cancelled prewait root work %s shutdown preserves the rotation fence",
  async (ordering) => {
    await runDst(
      { name: `claude-failed-cancellation-prewait-${ordering}`, iterations: 20 },
      async (sim) => {
        const f = new ComposedClaudeFixture();
        let produced = false;
        let release = () => {};
        const receipt = new Promise<{ still_queued: string[]; cancelled: string[] }>((resolve) => {
          release = () => resolve({ still_queued: [], cancelled: [] });
        });
        try {
          expect((await f.attach()).isOk()).toBe(true);
          const scheduled = await sim.runTasks([
            {
              name: "native-output",
              f: async (task) => {
                await submitReceipt(task, f);
                vi.spyOn(f.query, "interrupt").mockReturnValue(receipt);
                const request = f.query.requestShutdown.bind(f.query);
                const shutdown = new Promise<void>((resolve) => {
                  vi.spyOn(f.query, "requestShutdown").mockImplementation(() => {
                    const result = request();
                    resolve();
                    return result;
                  });
                });
                await f.query.emit(task, childEdge("task_started"));
                await f.query.emit(task, childEdge("task_notification"));
                await f.query.emit(task, failure);
                await f.query.emit(task, acknowledgment);
                if (ordering === "after") {
                  await task.checkpoint("receipt release before shutdown and prewait root signal");
                  release();
                  await shutdown;
                }
                await f.query.emit(task, rootRequest);
                await f.query.emit(task, {
                  ...failure,
                  uuid: "cancelled-prewait-result",
                  subtype: "error_during_execution",
                  num_turns: 2,
                  errors: ["Request was aborted."],
                } as unknown as SDKMessage);
                if (ordering === "before") {
                  await task.checkpoint("prewait root result consumed before receipt release");
                  release();
                  await shutdown;
                }
                produced = true;
                await task.checkpoint("all prewait output consumed before independent EOF");
                f.query.endOutput();
              },
            },
            {
              name: "supervisor",
              f: async (task) => {
                while (!produced) await task.sleep(1, "wait for prewait output");
                await task.checkpoint("direct process exit independent of stdout EOF");
                f.query.exit();
                await f.agent.closeExtensions();
              },
            },
          ]);
          expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
          if (ordering === "before") {
            expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
            expect(
              f.history.view.filter(
                (r) => r.type === "event" && r.eventType === "claude.operation_finished",
              ),
            ).toMatchObject([{ overflow: { outcome: "failed" } }]);
          } else {
            expect(f.journal().pendingHandoffs).toHaveProperty("child");
            expect(f.agent.liveView()?.subagents).toContainEqual(
              expect.objectContaining({ id: "child" }),
            );
            expect(f.agent.getHealth()).toMatchObject({
              status: "failed",
              error: { code: "claude_rotation_uncertain" },
            });
            expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
            expect(
              f.history.view.some(
                (r) => r.type === "event" && r.eventType === "claude.operation_finished",
              ),
            ).toBe(false);
            expect(
              f.history.view.some(
                (r) => r.type === "event" && r.eventType === "claude.rotation_failed",
              ),
            ).toBe(true);
          }
        } finally {
          release();
          f.query.exit();
          f.query.endOutput();
          await f.agent.closeExtensions();
          f.dispose();
        }
      },
    );
  },
);
