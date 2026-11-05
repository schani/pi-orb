import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import {
  ComposedClaudeFixture,
  childEdge,
  rootRequest,
  rootResult,
  submitReceipt,
} from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it.each(["before", "after"] as const)(
  "retains initial close and ordered buffered late edges with acknowledgment/tool completion %s requesting",
  async (acknowledgment) => {
    await runDst(
      { name: `claude-shutdown-evidence-${acknowledgment}`, iterations: 30 },
      async (sim) => {
        const f = new ComposedClaudeFixture();
        let rotating = false;
        try {
          expect((await f.attach()).isOk()).toBe(true);
          const scheduled = await sim.runTasks([
            {
              name: "native-stdout",
              f: async (task) => {
                await submitReceipt(task, f);
                await f.query.emit(task, {
                  ...f.resultForInitial(),
                  uuid: "initial-result",
                  num_turns: 9,
                } as unknown as SDKMessage);
                rotating = true;
                await task.checkpoint("late stdout can follow independent process exit");
                const ack = {
                  ...rootResult,
                  uuid: "late-ack",
                  num_turns: 0,
                } as unknown as SDKMessage;
                const bookends = [
                  { ...childEdge("task_started"), tool_use_id: "tool", task_type: "local_bash" },
                  { ...childEdge("task_notification"), tool_use_id: "tool" },
                ] as SDKMessage[];
                const toolResult = {
                  type: "user",
                  message: {
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: "tool",
                        is_error: false,
                        content: "PRIVATE_TOOL_OUTPUT",
                      },
                    ],
                  },
                } as unknown as SDKMessage;
                const messages =
                  acknowledgment === "before"
                    ? [ack, ...bookends, toolResult, rootRequest]
                    : [...bookends, rootRequest, toolResult, ack];
                expect(
                  await Promise.all(messages.map((message) => f.query.enqueue(message))),
                ).toEqual([true, true, true, true, true]);
                f.query.endOutput();
                await f.agent.closeExtensions();
              },
            },
            {
              name: "native-exit",
              f: async (task) => {
                while (!rotating) await task.sleep(1, "wait for initial close");
                await task.checkpoint("native exit independent of buffered late stdout");
                f.query.exit();
              },
            },
          ]);
          expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
          const failure = f.history.view.find(
            (record) => record.type === "event" && record.eventType === "claude.rotation_failed",
          );
          const diagnostics =
            failure?.type === "event" ? failure.overflow?.shutdownDiagnostics : null;
          const bookends = [
            { kind: "task_started", taskId: "child", taskKind: "local_bash", toolUseId: "tool" },
            { kind: "task_notification", taskId: "child", status: "completed", toolUseId: "tool" },
          ];
          const ack = { kind: "result", resultId: "late-ack", numTurns: 0 };
          const toolResult = { kind: "tool_result", toolUseId: "tool", isError: false };
          const request = { kind: "status", status: "requesting" };
          const expected =
            acknowledgment === "before"
              ? [ack, ...bookends, toolResult, request]
              : [...bookends, request, toolResult, ack];
          expect(diagnostics).toMatchObject({
            initialClose: {
              caller: "operation_drain",
              seq: 1,
              result: { resultId: "initial-result", numTurns: 9 },
              ownership: { ownedTasks: { count: 0 } },
            },
            droppedEdges: 0,
            edges: expected.map((edge, index) => ({ ...edge, seq: index + 2 })),
          });
          expect(JSON.stringify(failure)).not.toContain("PRIVATE_TOOL_OUTPUT");
          expect(f.agent.gateView()).toMatchObject({ activity: "busy", acceptingWork: false });
          expect(f.agent.getHealth()).toMatchObject({
            status: "failed",
            error: { code: "claude_rotation_uncertain" },
          });
          expect(
            f.history.view.some(
              (record) =>
                record.type === "event" && record.eventType === "claude.operation_finished",
            ),
          ).toBe(false);
        } finally {
          f.query.exit();
          f.query.endOutput();
          await f.agent.closeExtensions();
          f.dispose();
        }
      },
    );
  },
);
