import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type DisplayRecord, type HistoryRecord, projectDisplayRecords } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { LiveHistoryPublisher } from "./live-history.ts";

const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string) => ({
  id,
  parentId,
  type: "message",
  timestamp: `time-${id}`,
  message: {
    role,
    content: role === "user" ? [{ type: "text", text }] : [{ type: "text", text }],
    ...(role === "assistant" ? { stopReason: "stop" } : {}),
  },
});

describe("LiveHistoryPublisher", () => {
  it("seeds display matching from persisted calls without changing canonical records", () => {
    const entries: unknown[] = [
      {
        id: "call",
        parentId: null,
        timestamp: "t",
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c", name: "subagent", arguments: { prompt: "task" } }],
        },
      },
    ];
    const displays: unknown[] = [];
    const records: HistoryRecord[] = [];
    const publisher = new LiveHistoryPublisher(
      { getEntries: () => entries },
      (record, _message, display) => {
        records.push(record);
        displays.push(display);
      },
    );
    entries.push({
      id: "result",
      parentId: "call",
      timestamp: "t",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c",
        toolName: "subagent",
        content: [{ type: "text", text: "Agent completed. Findings" }],
        isError: false,
      },
    });
    expect(publisher.flushPersisted().isOk()).toBe(true);
    expect(displays).toMatchObject([{ id: "result", content: [{ headline: null }] }]);
    expect(JSON.stringify(records)).not.toContain("headline");
  });
  it("seeds all branches and matches incremental results only to their ancestors", () => {
    const calls = ["read", "subagent"].map((name) => ({
      id: name,
      parentId: "root",
      timestamp: "t",
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: {} }] },
    }));
    const results = ["read", "subagent"].map((name) => ({
      id: `${name}-result`,
      parentId: name,
      timestamp: "t",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c",
        toolName: "subagent",
        content: [
          { type: "text", text: name === "read" ? "READ_CANARY" : "Agent completed. Findings" },
        ],
        isError: false,
      },
    }));
    const all = [entry("root", null, "user", "task"), ...calls, ...results];
    for (let prefix = 0; prefix <= 3; prefix++) {
      const entries: unknown[] = all.slice(0, prefix);
      const records: HistoryRecord[] = [];
      const displays: DisplayRecord[] = [];
      const publisher = new LiveHistoryPublisher(
        { getEntries: () => entries },
        (record, _message, display) => {
          records.push(record);
          displays.push(display);
        },
      );
      for (const item of all.slice(prefix)) {
        entries.push(item);
        expect(publisher.flushPersisted().isOk()).toBe(true);
      }
      const read = displays.find((record) => record.id === "read-result");
      if (read?.type !== "message") throw new Error("expected read result");
      expect(read.content[0]).not.toHaveProperty("headline");
      expect(displays.at(-1)).toMatchObject({
        id: "subagent-result",
        content: [{ headline: null }],
      });
      expect(JSON.stringify(records)).not.toContain("headline");
      if (prefix === 0) expect(displays).toEqual(projectDisplayRecords(records));
    }
  });
  it("preserves SDK message identity across append and mapping, even for equal text", () => {
    const manager = SessionManager.inMemory();
    const messages: unknown[] = [];
    const publisher = new LiveHistoryPublisher(manager, (_record, message) =>
      messages.push(message),
    );
    const first = { role: "user" as const, content: "same", timestamp: 1 };
    const second = { role: "user" as const, content: "same", timestamp: 1 };
    manager.appendMessage(first);
    manager.appendMessage(second);
    expect(publisher.flushPersisted().isOk()).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(first);
    expect(messages[1]).toBe(second);
  });
  it("publishes an ordinary message persisted after message_end without entry_appended", async () => {
    const entries: unknown[] = [entry("old", null, "user", "already synchronized")];
    const published: HistoryRecord[] = [];
    const publisher = new LiveHistoryPublisher({ getEntries: () => entries }, (record) =>
      published.push(record),
    );

    // This is the Pi SDK ordering: subscribers receive message_end first;
    // AgentSession appends the native session entry after they return.
    publisher.observe("message_end");
    entries.push(entry("user-1", "old", "user", "new prompt"));
    await Promise.resolve();

    expect(published.map((record) => record.id)).toEqual(["user-1"]);
    expect(published[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "text", text: "new prompt" }],
    });
  });

  it("publishes system-state identity without prompt or tool payload", () => {
    const entries: unknown[] = [];
    const published: HistoryRecord[] = [];
    const publisher = new LiveHistoryPublisher({ getEntries: () => entries }, (record) =>
      published.push(record),
    );
    entries.push({
      id: "system-1",
      parentId: null,
      type: "message",
      timestamp: "time-system-1",
      message: {
        role: "system",
        content: "LIVE_SYSTEM_CONTENT_SENTINEL",
        sections: { project_context: "LIVE_SYSTEM_SECTION_SENTINEL" },
        toolsAdded: [
          {
            name: "live_sentinel_tool",
            description: "LIVE_SYSTEM_TOOL_SENTINEL",
            parameters: { type: "object" },
          },
        ],
        timestamp: 1,
      },
    });

    expect(publisher.flushPersisted().isOk()).toBe(true);

    expect(published).toMatchObject([
      {
        id: "system-1",
        parentId: null,
        type: "event",
        eventType: "pi.message.system",
        overflow: {
          native: {
            id: "system-1",
            parentId: null,
            type: "message",
            timestamp: "time-system-1",
            message: { role: "system", timestamp: 1 },
          },
        },
      },
    ]);
    expect(JSON.stringify(published)).not.toContain("LIVE_SYSTEM_");
  });

  it("flushes committed responses before agent_settled and never republishes entries", () => {
    const entries: unknown[] = [];
    const published: HistoryRecord[] = [];
    const publisher = new LiveHistoryPublisher({ getEntries: () => entries }, (record) =>
      published.push(record),
    );

    entries.push(entry("assistant-1", null, "assistant", "final response"));
    publisher.observe("agent_settled");
    publisher.observe("agent_settled");

    expect(published.map((record) => record.id)).toEqual(["assistant-1"]);
  });
});
