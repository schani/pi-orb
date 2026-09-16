import { HistoryRecordSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { mapPiEntry, mapPiSessionHeader } from "./mapping.ts";

const base = { id: "e2", parentId: "e1", timestamp: "2026-07-20T10:00:00.000Z" };

function expectMapped(entry: unknown) {
  const result = mapPiEntry(entry);
  expect(result.isOk(), `mapping failed: ${JSON.stringify(result)}`).toBe(true);
  if (!result.isOk()) throw new Error("unreachable");
  const record = result.value;
  expect(Check(HistoryRecordSchema, record), "mapped record must validate").toBe(true);
  expect(record.id).toBe(base.id);
  expect(record.parentId).toBe(base.parentId);
  expect(record.timestamp).toBe(base.timestamp);
  expect(record.overflow["native"]).toEqual(entry);
  return record;
}

describe("Pi entry mapping", () => {
  it("maps a user message with string content", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: { role: "user", content: "hello there", timestamp: 1 },
    });
    expect(record.type).toBe("message");
    if (record.type !== "message") return;
    expect(record.role).toBe("user");
    expect(record.content).toEqual([{ type: "text", text: "hello there" }]);
  });

  it("maps a user message with text and image blocks", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "aWpn", mimeType: "image/jpeg" },
        ],
        timestamp: 1,
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", mediaType: "image/jpeg", data: "aWpn" },
    ]);
  });

  it("maps an assistant message with thinking, text, tool calls, usage, and model", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "pondering...", redacted: false },
          { type: "text", text: "the answer" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "ls" } },
        ],
        api: "openai-responses",
        provider: "openai-codex",
        model: "gpt-5.2-codex",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 165,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.role).toBe("assistant");
    expect(record.content).toEqual([
      { type: "reasoning", text: "pondering...", redacted: false },
      { type: "text", text: "the answer" },
      { type: "tool_call", callId: "call-1", name: "bash", arguments: { cmd: "ls" } },
    ]);
    expect(record.model).toEqual({ provider: "openai-codex", id: "gpt-5.2-codex" });
    expect(record.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 165,
      costUsd: 0.33,
    });
    expect(record.finishReason).toBe("toolUse");
  });

  it("maps a tool result to a single typed tool_result block with role tool", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "file1\nfile2" }],
        isError: false,
        timestamp: 3,
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.role).toBe("tool");
    expect(record.content).toEqual([
      {
        type: "tool_result",
        callId: "call-1",
        content: [{ type: "text", text: "file1\nfile2" }],
        isError: false,
      },
    ]);
  });

  it("maps a bash execution message to an event with typed shell fields", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "bashExecution",
        command: "npm test",
        output: "ok",
        exitCode: 2,
        cancelled: false,
        truncated: true,
        excludeFromContext: false,
        timestamp: 4,
      },
    });
    expect(record.type).toBe("event");
    if (record.type !== "event") return;
    expect(record.eventType).toBe("pi.bash_execution");
    expect(record.shell).toEqual({
      command: "npm test",
      output: "ok",
      exitCode: 2,
      cancelled: false,
      truncated: true,
      excludeFromContext: false,
    });
  });

  it("maps a cancelled bash execution without an exit code", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: { role: "bashExecution", command: "sleep 10", output: "", cancelled: true },
    });
    if (record.type !== "event") throw new Error("expected event");
    expect(record.shell).toEqual({
      command: "sleep 10",
      output: "",
      exitCode: null,
      cancelled: true,
      truncated: false,
      excludeFromContext: false,
    });
  });

  it("maps a failed assistant message to a typed failure with diagnostic types", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "assistant",
        content: [],
        model: "gpt-5.2-codex",
        provider: "openai-codex",
        stopReason: "error",
        errorMessage: "WebSocket closed 1006",
        diagnostics: [
          { type: "provider_transport_failure", timestamp: 1 },
          { type: "stream_aborted", timestamp: 2 },
          "malformed",
        ],
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.failure).toEqual({
      message: "WebSocket closed 1006",
      diagnostics: ["provider_transport_failure", "stream_aborted"],
    });
  });

  it("maps a failed assistant message without diagnostics to an empty diagnostic list", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Codex error: the usage limit has been reached",
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.failure).toEqual({
      message: "Codex error: the usage limit has been reached",
      diagnostics: [],
    });
  });

  it("omits the failure of an assistant message that did not fail or has no message", () => {
    const succeeded = expectMapped({
      ...base,
      type: "message",
      message: { role: "assistant", content: [], stopReason: "stop" },
    });
    if (succeeded.type !== "message") throw new Error("expected message");
    expect(succeeded.failure).toBeUndefined();
    const blank = expectMapped({
      ...base,
      type: "message",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: " " },
    });
    if (blank.type !== "message") throw new Error("expected message");
    expect(blank.failure).toBeUndefined();
  });

  it("maps an edit tool result patch onto the tool_result block", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "edit",
        content: [{ type: "text", text: "updated" }],
        details: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n+new" },
        isError: false,
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.content[0]).toEqual({
      type: "tool_result",
      callId: "call-1",
      content: [{ type: "text", text: "updated" }],
      isError: false,
      patch: "--- a/src/a.ts\n+++ b/src/a.ts\n+new",
    });
  });

  it("omits the patch of a tool result that carries none", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "done" }],
        details: { exitCode: 0 },
        isError: false,
      },
    });
    if (record.type !== "message") throw new Error("expected message");
    const block = record.content[0];
    if (block?.type !== "tool_result") throw new Error("expected tool_result");
    expect(block.patch).toBeUndefined();
  });

  it("maps an unknown message role to a generic event", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: { role: "somethingNew", data: 1, timestamp: 5 },
    });
    if (record.type !== "event") throw new Error("expected event");
    expect(record.eventType).toBe("pi.message.somethingNew");
  });

  it("maps compaction to a CompactionRecord with a text summary block", () => {
    const record = expectMapped({
      ...base,
      type: "compaction",
      summary: "we discussed things",
      firstKeptEntryId: "e1",
      tokensBefore: 5000,
    });
    expect(record.type).toBe("compaction");
    if (record.type !== "compaction") return;
    expect(record.summary).toEqual([{ type: "text", text: "we discussed things" }]);
  });

  it("maps lifecycle entries to typed events", () => {
    expect(
      expectMapped({ ...base, type: "thinking_level_change", thinkingLevel: "high" }),
    ).toMatchObject({ type: "event", eventType: "pi.thinking_level_change" });
    expect(
      expectMapped({ ...base, type: "model_change", provider: "openai-codex", modelId: "gpt-x" }),
    ).toMatchObject({ type: "event", eventType: "pi.model_change" });
    expect(
      expectMapped({ ...base, type: "branch_summary", fromId: "e1", summary: "branch stuff" }),
    ).toMatchObject({
      type: "event",
      eventType: "pi.branch_summary",
      content: [{ type: "text", text: "branch stuff" }],
    });
    expect(
      expectMapped({ ...base, type: "custom", customType: "my-ext", data: { a: 1 } }),
    ).toMatchObject({ type: "event", eventType: "pi.custom" });
    expect(
      expectMapped({ ...base, type: "label", targetId: "e1", label: "bookmark" }),
    ).toMatchObject({ type: "event", eventType: "pi.label" });
    expect(expectMapped({ ...base, type: "session_info", name: "my session" })).toMatchObject({
      type: "event",
      eventType: "pi.session_info",
    });
  });

  it("maps the durable inbox custom message as an ordinary user message", () => {
    const record = expectMapped({
      ...base,
      type: "custom_message",
      customType: "pi-orb.user-message",
      content: [{ type: "text", text: "steer here" }],
      display: true,
      details: { messageId: "message-1" },
    });
    expect(record.type).toBe("message");
    if (record.type !== "message") return;
    expect(record.role).toBe("user");
    expect(record.content).toEqual([{ type: "text", text: "steer here" }]);
    expect(record.inboxMessageIds).toEqual(["message-1"]);
    expect(record.overflow.native).toMatchObject({ details: { messageId: "message-1" } });
  });

  it("maps a squashed inbox batch to every client message id in order", () => {
    const record = expectMapped({
      ...base,
      type: "custom_message",
      customType: "pi-orb.user-message",
      content: [{ type: "text", text: "two messages" }],
      display: true,
      details: { messageIds: ["message-1", "message-2"], delivery: "turn", operationId: "op-1" },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.inboxMessageIds).toEqual(["message-1", "message-2"]);
  });

  it("omits inbox ids from a user message that carries none", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: { role: "user", content: "typed in the terminal" },
    });
    if (record.type !== "message") throw new Error("expected message");
    expect(record.inboxMessageIds).toBeUndefined();
  });

  it("maps displayed and hidden custom messages to typed custom fields", () => {
    const shown = expectMapped({
      ...base,
      type: "custom_message",
      customType: "my-ext",
      content: "injected note",
      display: true,
    });
    if (shown.type !== "event") throw new Error("expected event");
    expect(shown.custom).toEqual({ customType: "my-ext", display: true });
    const hidden = expectMapped({
      ...base,
      type: "custom_message",
      customType: "my-ext",
      content: "model-only note",
      display: false,
    });
    if (hidden.type !== "event") throw new Error("expected event");
    expect(hidden.custom).toEqual({ customType: "my-ext", display: false });
    expect(hidden.subagent).toBeUndefined();
  });

  it("maps each subagent custom message to a typed subagent receipt", () => {
    const notification = expectMapped({
      ...base,
      type: "custom_message",
      customType: "subagent-notification",
      content: "<task-notification>machine instructions</task-notification>",
      display: true,
      details: {
        id: "child-1",
        description: "Check deployment",
        status: "error",
        error: "Unsupported model",
        resultPreview: "No output.",
        durationMs: 4200,
        outputFile: "/private/tasks/session.jsonl",
        toolUses: 3,
      },
    });
    if (notification.type !== "event") throw new Error("expected event");
    expect(notification.subagent).toEqual({
      kind: "notification",
      id: "child-1",
      description: "Check deployment",
      status: "error",
      error: "Unsupported model",
      resultPreview: "No output.",
      durationMs: 4200,
    });

    const update = expectMapped({
      ...base,
      type: "custom_message",
      customType: "subagent-update",
      content: "<subagent-update>progress</subagent-update>",
      display: true,
      details: { id: "child-2", description: "Check services", message: "halfway there" },
    });
    if (update.type !== "event") throw new Error("expected event");
    expect(update.subagent).toEqual({
      kind: "update",
      id: "child-2",
      description: "Check services",
      message: "halfway there",
    });

    const notice = expectMapped({
      ...base,
      type: "custom_message",
      customType: "subagent-workspace-notice",
      content: "workspace notice",
      display: true,
      details: { id: "child-3", description: "Clean up", notice: "Changes retained." },
    });
    if (notice.type !== "event") throw new Error("expected event");
    expect(notice.subagent).toEqual({
      kind: "workspace_notice",
      id: "child-3",
      description: "Clean up",
      notice: "Changes retained.",
    });
  });

  it("treats prototype-named custom types as ordinary custom messages", () => {
    for (const customType of ["toString", "constructor"]) {
      const record = expectMapped({
        ...base,
        type: "custom_message",
        customType,
        content: "note",
        display: true,
        details: { id: "child-9" },
      });
      if (record.type !== "event") throw new Error("expected event");
      expect(record.subagent, customType).toBeUndefined();
    }
  });

  it("maps custom_message with text content", () => {
    const record = expectMapped({
      ...base,
      type: "custom_message",
      customType: "my-ext",
      content: "injected note",
      display: true,
    });
    if (record.type !== "event") throw new Error("expected event");
    expect(record.eventType).toBe("pi.custom_message");
    expect(record.content).toEqual([{ type: "text", text: "injected note" }]);
  });

  it("maps unknown future entry types to pi.<type> events (cursor continuity)", () => {
    const record = expectMapped({ ...base, type: "hologram", payload: { x: 1 } });
    if (record.type !== "event") throw new Error("expected event");
    expect(record.eventType).toBe("pi.hologram");
  });

  it("rejects entries without identity as mapping failures", () => {
    const result = mapPiEntry({ type: "message", message: { role: "user", content: "x" } });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("mapping_failure");
  });

  it("maps the session header to metadata with full native overflow", () => {
    const header = {
      type: "session",
      version: 3,
      id: "sess-1",
      timestamp: "2026-07-20T09:00:00.000Z",
      cwd: "/work/repo",
    };
    const result = mapPiSessionHeader(header);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        id: "sess-1",
        timestamp: "2026-07-20T09:00:00.000Z",
        overflow: { native: header },
      });
    }
  });
});
