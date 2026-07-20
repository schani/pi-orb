import { describe, expect, it } from "vitest";
import type { HistoryRecord, ServerFrame } from "@pi-orb/protocol";
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

  it("reconstructs live operation state with replace patches and tool states", () => {
    const live: LiveOperationView = {
      operationId: "op-1",
      blocks: [{ blockId: "b1", blockType: "text", revision: 7, text: "partial out" }],
      tools: [{ callId: "c1", name: "bash", revision: 3, state: "running" }],
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
