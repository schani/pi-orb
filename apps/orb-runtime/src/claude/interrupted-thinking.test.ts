import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";

async function fixture(nativeReceipt = true) {
  const f = new ComposedClaudeFixture();
  expect((await f.attach()).isOk()).toBe(true);
  expect((await f.agent.submitMessage([{ type: "text", text: "boot" }], "op")).isOk()).toBe(true);
  const input = await f.query.input.next();
  if (input.done) throw new Error("missing input");
  if (nativeReceipt) f.receipt(input.value);
  expect(f.agent.snapshot().isOk()).toBe(true);
  const emit = (message: object) =>
    f.query.emitUnscheduled({
      session_id: f.state.id,
      parent_tool_use_id: null,
      ...message,
    } as SDKMessage);
  const stream = (event: object, rest: object = {}) =>
    emit({
      type: "stream_event",
      uuid: "stream",
      event,
      ...rest,
    });
  const start = (rest: object = {}) =>
    stream(
      {
        type: "message_start",
        message: { id: "api-response" },
      },
      { user_message_uuid: input.value.uuid, ...rest },
    );
  const block = (type = "thinking", index = 0) =>
    stream(
      {
        type: "content_block_start",
        index,
        content_block: { type, thinking: "in flight", text: "in flight", signature: "" },
      },
      { uuid: `block-${index}` },
    );
  const stop = () => stream({ type: "content_block_stop", index: 0 });
  const finish = () => stream({ type: "message_stop" });
  const result = (rest: object = {}) =>
    emit({
      type: "result",
      uuid: "result",
      subtype: "error_during_execution",
      is_error: true,
      terminal_reason: "aborted_streaming",
      user_message_uuid: input.value.uuid,
      num_turns: 1,
      queued_turn_count: 1,
      errors: ["interrupted"],
      ...rest,
    });
  const retired = () =>
    f.frames.flatMap((frame) =>
      frame.type === "history.record" &&
      frame.record.type === "event" &&
      frame.record.eventType === "claude.result_error"
        ? frame.retiredBlockIds
        : [],
    );
  const dispose = async () => {
    f.query.exit();
    f.query.endOutput();
    await f.agent.closeExtensions();
    await f.agent.waitForStream();
    f.dispose();
  };
  return {
    f,
    input: input.value,
    emit,
    stream,
    start,
    block,
    stop,
    finish,
    result,
    retired,
    dispose,
  };
}

it("retires stopped ownerless thinking only on publication of the existing error", async () => {
  const t = await fixture();
  try {
    await t.start();
    await t.block();
    await t.stop();
    await t.finish();
    expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
    await t.result();
    expect(t.retired()).toEqual(["block-0:0"]);
    expect(t.f.agent.liveView()?.blocks).toEqual([]);
    const record = t.f.history.view.find(
      (record) => record.type === "event" && record.eventType === "claude.result_error",
    );
    expect(record?.overflow).not.toHaveProperty("retiredBlockIds");
    expect(record?.overflow).not.toHaveProperty("terminalReason");
    await t.result();
    expect(t.retired()).toEqual(["block-0:0"]);
  } finally {
    await t.dispose();
  }
});

it.each([
  "no-start",
  "no-block-stop",
  "no-message-stop",
  "no-start-input",
  "no-result-input",
  "wrong-input",
  "wrong-reason",
  "no-reason",
  "wrong-subtype",
  "not-error",
  "wrong-start-session",
  "wrong-stop-session",
  "wrong-result-session",
  "replacement-start",
  "text",
  "redacted",
  "owned",
  "native-owner",
  "native-wrong-role",
  "unaccepted-input",
  "wrong-operation",
  "no-api-id",
  "no-block-uuid",
] as const)("keeps uncertain interrupted output: %s", async (mode) => {
  const t = await fixture();
  try {
    if (mode === "no-api-id")
      await t.stream({ type: "message_start", message: {} }, { user_message_uuid: t.input.uuid });
    else if (mode !== "no-start")
      await t.start(
        mode === "no-start-input"
          ? { user_message_uuid: undefined }
          : mode === "wrong-start-session"
            ? { session_id: "other-session" }
            : mode === "unaccepted-input"
              ? { user_message_uuid: "unaccepted" }
              : {},
      );
    if (mode === "no-block-uuid")
      await t.stream(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "partial", signature: "" },
        },
        { uuid: undefined },
      );
    else
      await t.block(
        mode === "text" ? "text" : mode === "redacted" ? "redacted_thinking" : "thinking",
      );
    if (mode === "replacement-start") await t.start();
    if (mode === "owned")
      await t.emit({
        type: "assistant",
        uuid: "native-owner",
        message: {
          id: "api-response",
          role: "assistant",
          content: [{ type: "thinking", thinking: "done" }],
        },
      });
    if (mode.startsWith("native-"))
      t.f.append({
        type: mode === "native-owner" ? "assistant" : "user",
        uuid: "durable-owner",
        message: {
          id: "api-response",
          role: mode === "native-owner" ? "assistant" : "user",
          content: [{ type: "thinking", thinking: "done" }],
        },
      });
    if (mode !== "no-block-stop")
      await t.stream(
        { type: "content_block_stop", index: 0 },
        mode === "wrong-stop-session" ? { session_id: "other-session" } : {},
      );
    if (mode !== "no-message-stop") await t.finish();
    if (mode === "wrong-operation") {
      const delivery = Object.values(t.f.state.deliveries)[0];
      if (delivery === undefined) throw new Error("missing accepted delivery");
      delivery.operationId = "other-operation";
    }
    await t.result({
      ...(mode === "unaccepted-input" ? { user_message_uuid: "unaccepted" } : {}),
      ...(mode === "no-result-input" ? { user_message_uuid: undefined } : {}),
      ...(mode === "wrong-input" ? { user_message_uuid: "other-input" } : {}),
      ...(mode === "wrong-reason" ? { terminal_reason: "completed" } : {}),
      ...(mode === "no-reason" ? { terminal_reason: undefined } : {}),
      ...(mode === "wrong-subtype" ? { subtype: "error_max_turns" } : {}),
      ...(mode === "not-error" ? { is_error: false } : {}),
      ...(mode === "wrong-result-session" ? { session_id: "other-session" } : {}),
    });
    expect(t.retired()).toEqual([]);
    expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual([
      mode === "no-block-uuid" ? "undefined:0" : "block-0:0",
    ]);
  } finally {
    await t.dispose();
  }
});

it("does not adopt an older orphan or a mixed text block", async () => {
  const t = await fixture();
  try {
    await t.block("thinking", 9);
    await t.start();
    await t.block();
    await t.block("text", 1);
    await t.stop();
    await t.finish();
    await t.result();
    expect(t.retired()).toEqual(["block-0:0"]);
    expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual([
      "block-9:9",
      "block-1:1",
    ]);
  } finally {
    await t.dispose();
  }
});

it.each(["append", "scan"] as const)("retains blocks when durable %s fails", async (mode) => {
  const t = await fixture();
  try {
    await t.start();
    await t.block();
    await t.stop();
    await t.finish();
    if (mode === "append") t.f.failCommit = true;
    else t.f.failSync = true;
    await t.result();
    expect(t.f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
    expect(t.retired()).toEqual([]);
    expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
    t.f.failCommit = false;
    t.f.failSync = false;
    expect(t.f.agent.snapshot().isErr()).toBe(true);
    await t.dispose();
    expect(t.f.agent.getHealth()).toMatchObject({
      status: "failed",
      error: { code: "history_unavailable" },
    });
  } finally {
    await t.dispose();
  }
});

it.each([
  ["error", false],
  ["error", true],
  ["steering", false],
  ["steering", true],
] as const)(
  "requires a committed %s owner across publication failure (committed=%s)",
  async (kind, committed) => {
    const t = await fixture();
    const originalCommit = t.f.files.commit;
    const eventType = kind === "error" ? "claude.result_error" : "claude.steering_result";
    const code = kind === "error" ? "history_unavailable" : "claude_steering_persistence_failed";
    const retired = () =>
      t.f.frames.flatMap((frame) =>
        frame.type === "history.record" &&
        frame.record.type === "event" &&
        frame.record.eventType === eventType
          ? frame.retiredBlockIds
          : [],
      );
    try {
      if (kind === "steering") {
        expect(
          (
            await t.f.agent.deliverInboxMessage(
              "steer",
              ["steer"],
              [{ type: "text", text: "steer" }],
            )
          ).isOk(),
        ).toBe(true);
        await t.f.query.input.next();
      }
      await t.start();
      await t.block();
      await t.stop();
      await t.finish();
      t.f.append({
        type: "assistant",
        uuid: "future-native",
        message: {
          role: "assistant",
          id: "future-api",
          content: [{ type: "text", text: "later" }],
        },
      });
      t.f.files.commit = (path, text) => {
        const containsError =
          path.endsWith("index.json") && text.includes(`"eventType":"${eventType}"`);
        if (!committed && containsError) throw new Error("injected error append failure");
        originalCommit(path, text);
        if (committed && containsError) t.f.failSync = true;
      };
      await t.result(kind === "steering" ? { subtype: "success", is_error: false } : {});
      expect(t.f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: { code },
      });
      expect(retired()).toEqual([]);
      expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
      expect(
        t.f.frames.some(
          (frame) => frame.type === "history.record" && frame.record.id === "future-native",
        ),
      ).toBe(false);
      t.f.files.commit = originalCommit;
      t.f.failSync = false;
      await t.dispose();
      expect(t.f.agent.getHealth()).toMatchObject({
        status: "failed",
        error: { code },
      });
      expect(retired()).toEqual(committed ? ["block-0:0"] : []);
      expect(
        t.f.frames.some(
          (frame) => frame.type === "history.record" && frame.record.id === "future-native",
        ),
      ).toBe(committed);
    } finally {
      t.f.files.commit = originalCommit;
      t.f.failSync = false;
      await t.dispose();
    }
  },
);

it.each([false, true])("requires the accepted input's native receipt (path=%s)", async (path) => {
  const t = await fixture(false);
  try {
    if (path)
      t.f.append({
        type: "user",
        uuid: "unrelated-input",
        message: { role: "user", content: "other" },
      });
    await t.start();
    await t.block();
    await t.stop();
    await t.finish();
    await t.result();
    expect(t.retired()).toEqual([]);
    expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
  } finally {
    await t.dispose();
  }
});

it.each(["missing-native", "wrong-api", "wrong-role", "missing-stop"] as const)(
  "does not inherit a turn anchor through an unproven predecessor: %s",
  async (mode) => {
    const t = await fixture();
    try {
      const tool = { type: "tool_use", id: "tool", name: "fixed", input: {} };
      await t.start();
      await t.stream({ type: "content_block_start", index: 0, content_block: tool });
      await t.emit({
        type: "assistant",
        uuid: "prior-owner",
        message: { id: "api-response", role: "assistant", content: [tool] },
      });
      await t.stop();
      if (mode !== "missing-stop") await t.finish();
      if (mode !== "missing-native")
        t.f.append({
          type: mode === "wrong-role" ? "user" : "assistant",
          uuid: "prior-owner",
          message: {
            id: mode === "wrong-api" ? "other-api" : "api-response",
            role: mode === "wrong-role" ? "user" : "assistant",
            content: [tool],
          },
        });
      await t.stream({ type: "message_start", message: { id: "current-api" } });
      await t.block();
      await t.stop();
      await t.finish();
      await t.result();
      expect(t.retired()).toEqual([]);
      expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
    } finally {
      await t.dispose();
    }
  },
);

it("does not retire if a matching native owner becomes durable after the event", async () => {
  const t = await fixture(false);
  try {
    await t.start();
    await t.block();
    await t.stop();
    await t.finish();
    await t.result();
    expect(t.retired()).toEqual([]);
    t.f.receipt(t.input);
    t.f.append({
      type: "assistant",
      uuid: "late-owner",
      message: {
        id: "api-response",
        role: "assistant",
        content: [{ type: "thinking", thinking: "native" }],
      },
    });
    expect(t.f.agent.snapshot().isOk()).toBe(true);
    expect(t.retired()).toEqual([]);
    expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
  } finally {
    await t.dispose();
  }
});

it.each(["other-accepted", "invalid-then-valid"] as const)(
  "does not rebind a response's thinking after an explicit conflicting echo: %s",
  async (mode) => {
    const t = await fixture();
    try {
      expect(
        (
          await t.f.agent.deliverInboxMessage("steer", ["steer"], [{ type: "text", text: "steer" }])
        ).isOk(),
      ).toBe(true);
      const second = await t.f.query.input.next();
      if (second.done) throw new Error("missing accepted steer");
      t.f.receipt(second.value);
      expect(t.f.agent.snapshot().isOk()).toBe(true);
      await t.start();
      await t.block();
      await t.stream(
        { type: "content_block_stop", index: 0 },
        {
          user_message_uuid: mode === "other-accepted" ? second.value.uuid : "unaccepted-input",
        },
      );
      const resultInput = mode === "other-accepted" ? second.value.uuid : t.input.uuid;
      await t.stream({ type: "message_stop" }, { user_message_uuid: resultInput });
      await t.result({ user_message_uuid: resultInput });
      expect(t.retired()).toEqual([]);
      expect(t.f.agent.liveView()?.blocks.map((block) => block.blockId)).toEqual(["block-0:0"]);
    } finally {
      await t.dispose();
    }
  },
);
