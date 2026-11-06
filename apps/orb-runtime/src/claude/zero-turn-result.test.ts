import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import {
  ComposedClaudeFixture,
  nativeHook,
  nativeHookResponse,
  rootResult,
} from "../testkit/claude-composed.ts";

const ack = { ...rootResult, num_turns: 0 } as SDKMessage;
const content = [{ type: "text" as const, text: "/help" }];

it("an orphan acknowledgment before enqueue preserves the admitted human root", async () => {
  let release = () => {};
  const account = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = new ComposedClaudeFixture(account);
  try {
    (await f.attach())._unsafeUnwrap();
    const next = f.nextQuery();
    const admitted = f.agent.deliverInboxMessage("human", ["human"], content);
    await next;
    await f.query.emitUnscheduled(ack);
    expect(f.query.closeRequested).toBe(false);
    expect(f.state.deliveries.human).toBeUndefined();
    expect(
      f.history.view.find(
        (record) =>
          record.type === "event" && record.eventType === "claude.continuation.root_result",
      ),
    ).toMatchObject({ overflow: { numTurns: 0, pendingHandoffs: 0 } });
    expect(
      f.history.view.find(
        (record) => record.type === "event" && record.eventType === "claude.continuation.decision",
      ),
    ).toMatchObject({ overflow: { holds: ["root"] } });
    release();
    (await admitted)._unsafeUnwrap();
    const input = (await f.query.input.next()).value!;
    f.receipt(input);
    await f.query.emitUnscheduled({
      ...rootResult,
      user_message_uuids: [input.uuid],
    } as SDKMessage);
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    release();
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    f.dispose();
  }
});

it.each(["singular", "plural", "empty-plural", "error", "positive-unowned"] as const)(
  "%s zero-turn result still settles the root",
  async (kind) => {
    const f = new ComposedClaudeFixture();
    try {
      (await f.attach())._unsafeUnwrap();
      (await f.agent.deliverInboxMessage("human", ["human"], content))._unsafeUnwrap();
      const input = (await f.query.input.next()).value!;
      f.receipt(input);
      await f.query.emitUnscheduled({
        ...ack,
        ...(kind === "error"
          ? { subtype: "error_during_execution", is_error: true, errors: ["failed"] }
          : kind === "positive-unowned"
            ? { num_turns: 1 }
            : kind === "empty-plural"
              ? { user_message_uuid: input.uuid, user_message_uuids: [] }
              : kind === "singular"
                ? { user_message_uuid: input.uuid }
                : { user_message_uuids: [input.uuid] }),
      } as SDKMessage);
      expect(f.query.closeRequested).toBe(true);
      f.query.exit();
      f.query.endOutput();
      await f.agent.closeExtensions();
      expect(
        f.history.view.find(
          (record) => record.type === "event" && record.eventType === "claude.operation_finished",
        ),
      ).toMatchObject({ overflow: { outcome: kind === "error" ? "failed" : "completed" } });
      expect(
        f.history.view.some(
          (record) =>
            record.type === "event" && record.eventType.startsWith("claude.continuation."),
        ),
      ).toBe(false);
    } finally {
      f.dispose();
    }
  },
);

it("an orphan acknowledgment cannot resurrect a completed root held by a hook", async () => {
  const f = new ComposedClaudeFixture();
  try {
    (await f.attach())._unsafeUnwrap();
    (await f.agent.deliverInboxMessage("human", ["human"], content))._unsafeUnwrap();
    f.receipt((await f.query.input.next()).value!);
    const hook = nativeHook("root-hook");
    await f.query.emitUnscheduled(hook);
    await f.query.emitUnscheduled(rootResult);
    expect(f.query.closeRequested).toBe(false);
    await f.query.emitUnscheduled(ack);
    await f.query.emitUnscheduled(nativeHookResponse(hook));
    expect(f.query.closeRequested).toBe(true);
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    expect(f.agent.getHealth()).toMatchObject({ status: "ready", activity: "idle" });
  } finally {
    f.dispose();
  }
});
