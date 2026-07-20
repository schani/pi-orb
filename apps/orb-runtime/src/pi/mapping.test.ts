import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { HistoryRecordSchema } from "@pi-orb/protocol";
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

  it("maps a bash execution message to an event", () => {
    const record = expectMapped({
      ...base,
      type: "message",
      message: {
        role: "bashExecution",
        command: "npm test",
        output: "ok",
        excludeFromContext: false,
        timestamp: 4,
      },
    });
    expect(record.type).toBe("event");
    if (record.type !== "event") return;
    expect(record.eventType).toBe("pi.bash_execution");
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
