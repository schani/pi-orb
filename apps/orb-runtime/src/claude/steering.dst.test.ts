import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ComposedClaudeFixture, rootResult } from "../testkit/claude-composed.ts";
import { runDst } from "../testkit/sim.ts";

const content = [{ type: "text" as const, text: "change course" }];

it("steering races root completion without dropping accepted input or releasing ownership early", async () => {
  await runDst({ name: "claude-steering-root-completion", iterations: 40 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    try {
      await f.attach();
      const first = (
        await f.agent.deliverInboxMessage("first", ["first"], content)
      )._unsafeUnwrap();
      const input = (await f.query.input.next()).value;
      if (input === undefined) throw new Error("Initial input missing.");
      f.receipt(input);
      let delivered = false;
      let accepted = false;
      let originalFinished = false;
      const result = await sim.runTasks([
        {
          name: "ingress",
          f: async (task) => {
            await task.checkpoint("steering admission races original result");
            const response = await f.agent.deliverInboxMessage("steer", ["steer"], content);
            accepted = response.isOk();
            delivered = true;
            if (response.isOk())
              expect(response.value).toMatchObject({
                delivery: "steer",
                operationId: first.operationId,
              });
            else expect(f.journal().deliveries.steer).toBeUndefined();
          },
        },
        {
          name: "original-turn",
          f: async (task) => {
            await f.query.emit(task, {
              ...rootResult,
              user_message_uuid: input.uuid,
              user_message_uuids: [input.uuid],
            } as SDKMessage);
            originalFinished = true;
          },
        },
        {
          name: "native-drain",
          f: async (task) => {
            while (!delivered || !originalFinished)
              await task.sleep(1, "wait for admission and original result");
            if (accepted) {
              expect(f.query.closeRequested).toBe(false);
              expect(f.agent.prepareIdleStop()._unsafeUnwrap()).toBe(false);
              const steer = (await f.query.input.next()).value;
              if (steer === undefined) throw new Error("Accepted steer missing.");
              expect(steer).toMatchObject({ priority: "now", origin: { kind: "human" } });
              f.receipt(steer);
              await task.checkpoint("durable steering receipt before final result");
              await f.query.emit(task, {
                ...rootResult,
                user_message_uuid: steer.uuid,
                user_message_uuids: [steer.uuid],
              } as SDKMessage);
            }
            expect(f.query.closeRequested).toBe(true);
            f.query.exit();
            await task.checkpoint("native exit before independent stdout drain");
            expect(f.agent.gateView().activity).toBe("busy");
            f.query.endOutput();
            await f.agent.closeExtensions();
            await task.checkpoint("final publication before admission opens");
            expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
            const journal = f.journal();
            expect(Object.keys(journal.deliveries)).toHaveLength(accepted ? 2 : 1);
            if (accepted) {
              const steer = journal.deliveries.steer;
              expect(f.history.view.find((record) => record.id === steer?.uuid)).toMatchObject({
                inboxMessageIds: ["steer"],
              });
            }
            expect(
              f.history.view.filter(
                (record) =>
                  record.type === "event" && record.eventType === "claude.operation_finished",
              ),
            ).toHaveLength(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    } finally {
      f.query.exit();
      f.query.endOutput();
      f.dispose();
    }
  });
});

it("steering races Abort with durable acceptance or retryable refusal, never silent loss", async () => {
  await runDst({ name: "claude-steering-abort", iterations: 40 }, async (sim) => {
    const f = new ComposedClaudeFixture();
    try {
      await f.attach();
      await f.agent.deliverInboxMessage("first", ["first"], content);
      const input = (await f.query.input.next()).value;
      if (input === undefined) throw new Error("Initial input missing.");
      f.receipt(input);
      let delivered = false;
      let accepted = false;
      let cancelling = false;
      const result = await sim.runTasks([
        {
          name: "ingress",
          f: async (task) => {
            await task.checkpoint("steer admission races cancellation epoch");
            const response = await f.agent.deliverInboxMessage("steer", ["steer"], content);
            accepted = response.isOk();
            delivered = true;
            if (response.isErr()) expect(response.error.retryable).toBe(true);
          },
        },
        {
          name: "abort",
          f: async (task) => {
            await task.checkpoint("explicit Abort fences new steering");
            cancelling = true;
            const outcome = await f.agent.abortOperation();
            expect(outcome.isOk()).toBe(!accepted);
          },
        },
        {
          name: "native-drain",
          f: async (task) => {
            while (!delivered || !cancelling || !f.query.closeRequested)
              await task.sleep(1, "await cancellation and delivery decision");
            await task.checkpoint("native process exit with no steering receipt");
            f.query.exit();
            await task.checkpoint("stdout EOF independently of cancellation");
            f.query.endOutput();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      if (accepted) {
        expect(f.journal().deliveries.steer).toMatchObject({ steer: true, submitted: true });
        expect(f.agent.getHealth()).toMatchObject({
          status: "failed",
          error: { code: "claude_delivery_uncertain" },
        });
        expect(f.agent.gateView().activity).toBe("busy");
      } else {
        expect(f.journal().deliveries.steer).toBeUndefined();
        expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
      }
    } finally {
      f.query.exit();
      f.query.endOutput();
      f.dispose();
    }
  });
});
