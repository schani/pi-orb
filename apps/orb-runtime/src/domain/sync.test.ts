import type { HistoryRecord, ServerFrame } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { computeSyncFrames } from "./sync.ts";
import type { HarnessSnapshot, LiveOperationView } from "./types.ts";

function makeRecords(n: number): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (let i = 1; i <= n; i++) {
    records.push({
      id: `rec-${i}`,
      parentId: i === 1 ? null : `rec-${i - 1}`,
      timestamp: `t${i}`,
      overflow: { native: { i } },
      type: "message",
      role: "user",
      content: [{ type: "text", text: `m${i}` }],
    });
  }
  return records;
}

function snapshot(n: number, activity: "idle" | "busy" = "idle"): HarnessSnapshot {
  const records = makeRecords(n);
  return {
    orbId: "orb-a",
    runtimeInstanceId: "run-1",
    activity,
    session: { id: "sess-1", overflow: { native: {} } },
    records,
    headId: records.at(-1)?.id ?? null,
  };
}

const frameTypes = (frames: ServerFrame[]) => frames.map((frame) => frame.type);

describe("computeSyncFrames", () => {
  it("replays public live code unchanged without arguments or tool bodies", () => {
    const code = "  echo first\n\techo second  ";
    const live: LiveOperationView = {
      operationId: "op",
      blocks: [],
      subagents: [],
      tools: [{ callId: "c", name: "bash", code, revision: 1, state: "running" }],
    };
    const frames = computeSyncFrames(snapshot(0, "busy"), live, null, "now");
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "runtime.event",
        event: {
          type: "tool_state",
          operationId: "op",
          callId: "c",
          name: "bash",
          code,
          revision: 1,
          state: "running",
        },
      }),
    );
  });
  it("projects result markers using calls before the replay cursor", () => {
    const source = snapshot(0);
    const records: HistoryRecord[] = [
      {
        id: "call",
        parentId: null,
        timestamp: "t",
        overflow: {},
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_call", callId: "c", name: "subagent", arguments: { prompt: "task" } },
        ],
      },
      {
        id: "result",
        parentId: "call",
        timestamp: "t",
        overflow: {},
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "c",
            content: [{ type: "text", text: "Agent completed. Findings" }],
          },
        ],
      },
    ];
    const frames = computeSyncFrames({ ...source, records, headId: "result" }, null, "call", "now");
    expect(frames.filter((frame) => frame.type === "history.record")).toMatchObject([
      { record: { id: "result", content: [{ headline: null }] } },
    ]);
  });
  it("projects all-branch snapshots causally before slicing the replay cursor", () => {
    const records: HistoryRecord[] = [
      ...["read", "subagent"].map(
        (name): HistoryRecord => ({
          id: name,
          parentId: null,
          timestamp: "t",
          overflow: {},
          type: "message",
          role: "assistant",
          content: [{ type: "tool_call", callId: "c", name, arguments: {} }],
        }),
      ),
      ...["read", "subagent"].map(
        (name): HistoryRecord => ({
          id: `${name}-result`,
          parentId: name,
          timestamp: "t",
          overflow: {},
          type: "message",
          role: "tool",
          content: [
            {
              type: "tool_result",
              callId: "c",
              content: [{ type: "text", text: name === "read" ? "READ_CANARY" : "done" }],
            },
          ],
        }),
      ),
    ];
    const before = JSON.stringify(records);
    for (const cursor of [null, "read", "subagent"]) {
      const frames = computeSyncFrames(
        { ...snapshot(0), records, headId: "subagent-result" },
        null,
        cursor,
        "now",
      );
      const read = frames.find(
        (frame) => frame.type === "history.record" && frame.record.id === "read-result",
      );
      if (read?.type !== "history.record" || read.record.type !== "message")
        throw new Error("expected read result");
      expect(read.record.content[0]).not.toHaveProperty("headline");
      expect(frames.filter((frame) => frame.type === "history.record").at(-1)).toMatchObject({
        record: { id: "subagent-result", content: [{ headline: null }] },
      });
    }
    expect(JSON.stringify(records)).toBe(before);
  });
  it("replays everything in full mode for an unknown cursor", () => {
    const frames = computeSyncFrames(snapshot(2), null, "rec-unknown", "now");
    expect(frameTypes(frames)).toEqual([
      "sync.started",
      "history.record",
      "history.record",
      "runtime.event",
      "sync.completed",
    ]);
    const started = frames[0];
    if (started?.type !== "sync.started") throw new Error("expected sync.started");
    expect(started.mode).toBe("full");
    expect(started.afterRecordId).toBeNull();
  });

  it("replays only records after a known cursor", () => {
    const frames = computeSyncFrames(snapshot(4), null, "rec-2", "now");
    const records = frames.filter((frame) => frame.type === "history.record");
    expect(
      records.map((frame) => (frame.type === "history.record" ? frame.record.id : "")),
    ).toEqual(["rec-3", "rec-4"]);
    const started = frames[0];
    if (started?.type !== "sync.started") throw new Error("expected sync.started");
    expect(started.mode).toBe("after");
    expect(started.afterRecordId).toBe("rec-2");
  });

  it("ends with sync.completed carrying the head", () => {
    const frames = computeSyncFrames(snapshot(3), null, null, "now");
    const completed = frames.at(-1);
    if (completed?.type !== "sync.completed") throw new Error("expected sync.completed");
    expect(completed.headId).toBe("rec-3");
  });

  it("never exposes hidden bodies in full or delta replay, including active reasoning", () => {
    const source = snapshot(1, "busy");
    const records: HistoryRecord[] = [
      ...source.records,
      {
        id: "r2",
        parentId: "rec-1",
        timestamp: "t",
        type: "message",
        role: "assistant",
        overflow: { native: "SECRET_CANARY" },
        content: [
          { type: "reasoning", text: "SECRET_CANARY" },
          {
            type: "tool_call",
            callId: "call",
            name: "bash",
            arguments: { command: "echo ok", hidden: "SECRET_CANARY" },
          },
        ],
      },
    ];
    const withHidden = { ...source, records };
    const live: LiveOperationView = {
      operationId: "op",
      blocks: [
        {
          blockId: "b",
          blockType: "reasoning",
          contentIndex: 0,
          revision: 2,
          text: "SECRET_CANARY",
        },
      ],
      tools: [],
      subagents: [],
    };
    for (const cursor of [null, "rec-1"]) {
      const frames = computeSyncFrames(withHidden, live, cursor, "now");
      expect(JSON.stringify(frames)).not.toContain("SECRET_CANARY");
      expect(frames.filter((frame) => frame.type === "history.record").at(-1)).toMatchObject({
        record: { id: "r2", parentId: "rec-1" },
      });
    }
  });

  it("replays compact reasoning headings in full and delta sync without bodies", () => {
    const live: LiveOperationView = {
      operationId: "op",
      tools: [],
      subagents: [],
      blocks: [
        {
          blockId: "b",
          blockType: "reasoning",
          contentIndex: 0,
          revision: 2,
          text: "# Inspect\n\nSECRET_CANARY\n\n**Fix**",
        },
        {
          blockId: "redacted",
          blockType: "reasoning",
          contentIndex: 1,
          revision: 1,
          text: "# REDACTED_HEADING",
          redacted: true,
        },
      ],
    };
    for (const cursor of [null, "rec-1"]) {
      const frames = computeSyncFrames(snapshot(1, "busy"), live, cursor, "now");
      expect(frames).toContainEqual({
        v: 1,
        type: "runtime.event",
        at: "now",
        event: {
          type: "output_patch",
          operationId: "op",
          blockId: "b",
          blockType: "reasoning",
          contentIndex: 0,
          reasoningVisible: true,
          revision: 2,
          headline: "Inspect · Fix",
          patch: { type: "replace", text: "" },
        },
      });
      expect(JSON.stringify(frames)).not.toContain("SECRET_CANARY");
      expect(JSON.stringify(frames)).not.toContain("REDACTED_HEADING");
      expect(frames).toContainEqual({
        v: 1,
        type: "runtime.event",
        at: "now",
        event: {
          type: "output_patch",
          operationId: "op",
          blockId: "redacted",
          blockType: "reasoning",
          contentIndex: 1,
          reasoningVisible: true,
          revision: 1,
          headline: "",
          patch: { type: "replace", text: "" },
        },
      });
    }
  });

  it("reconstructs live operation state with replace patches and tool states", () => {
    const live: LiveOperationView = {
      operationId: "op-1",
      blocks: [
        { blockId: "b1", blockType: "text", contentIndex: 0, revision: 7, text: "partial out" },
      ],
      tools: [{ callId: "c1", name: "bash", revision: 3, state: "running" }],
      subagents: [{ id: "child", description: "Check deployment", phase: "running" }],
    };
    const frames = computeSyncFrames(snapshot(2, "busy"), live, null, "now");
    const events = frames
      .filter((frame) => frame.type === "runtime.event")
      .map((frame) => (frame.type === "runtime.event" ? frame.event : null));
    expect(events).toEqual([
      { type: "operation_started", operationId: "op-1" },
      {
        type: "output_patch",
        operationId: "op-1",
        blockId: "b1",
        blockType: "text",
        contentIndex: 0,
        revision: 7,
        patch: { type: "replace", text: "partial out" },
      },
      {
        type: "tool_state",
        operationId: "op-1",
        callId: "c1",
        name: "bash",
        revision: 3,
        state: "running",
      },
      { type: "subagents", operationId: "op-1", children: live.subagents },
      { type: "status", activity: "busy", operationId: "op-1" },
    ]);
  });

  it("emits an idle status event when no operation is live", () => {
    const frames = computeSyncFrames(snapshot(1), null, null, "now");
    const events = frames.filter((frame) => frame.type === "runtime.event");
    expect(events).toHaveLength(1);
    const only = events[0];
    if (only?.type !== "runtime.event") throw new Error("expected runtime.event");
    expect(only.event).toEqual({ type: "status", activity: "idle" });
  });
});
