import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

it.each([false, true])(
  "initial input survives startup/result/cancellation schedules (abort=%s)",
  async (abort) => {
    await runDst(
      { name: `claude-initial-input-${abort ? "abort" : "complete"}`, iterations: 40 },
      async (sim) => {
        let release = () => {};
        const account = new Promise<void>((resolve) => {
          release = resolve;
        });
        const f = new ComposedClaudeFixture(account);
        let finishing = false;
        try {
          (await f.attach())._unsafeUnwrap();
          const next = f.nextQuery();
          const admitted = f.agent.deliverInboxMessage(
            "initial",
            ["initial"],
            [{ type: "text", text: "/help" }],
          );
          await next;
          const scheduled = await sim.runTasks([
            {
              name: "startup",
              f: async (task) => {
                await task.checkpoint("account startup may precede unrelated result");
                release();
              },
            },
            {
              name: "unrelated-result",
              f: async (task) => {
                await f.query.emit(task, {
                  ...rootResult,
                  uuid: "11111111-1111-4111-8111-111111111111",
                  num_turns: 0,
                } as SDKMessage);
                if (!finishing) expect(f.query.closeRequested).toBe(false);
              },
            },
            {
              name: "owner",
              f: async (task) => {
                expect((await admitted).isOk()).toBe(true);
                const input = (await f.query.input.next()).value;
                if (input === undefined) throw new Error("Missing admitted input.");
                f.receipt(input);
                await task.checkpoint("durable initial receipt before terminal action");
                finishing = true;
                if (abort) {
                  const cancelled = f.agent.abortOperation();
                  f.query.exit();
                  f.query.endOutput();
                  expect((await cancelled).isOk()).toBe(true);
                } else {
                  await f.query.emit(task, {
                    ...rootResult,
                    num_turns: 0,
                    user_message_uuids: [input.uuid],
                  } as SDKMessage);
                  expect(f.query.closeRequested).toBe(true);
                  f.query.exit();
                  f.query.endOutput();
                  await f.agent.closeExtensions();
                }
              },
            },
          ]);
          expect(scheduled.isErr() ? scheduled.error : null).toBeNull();
          expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
          expect(
            f.history.view.find(
              (record) =>
                record.type === "event" && record.eventType === "claude.operation_finished",
            ),
          ).toMatchObject({ overflow: { outcome: abort ? "aborted" : "completed" } });
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
