import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@pi-orb/protocol";
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
