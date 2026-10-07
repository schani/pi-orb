import type { HistoryRecord } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { computeSyncFrames } from "./sync.ts";
import type { HarnessSnapshot } from "./types.ts";

it("replays subscription attachment identity without transcript content on full and cursor reconnect", () => {
  const prefix: HistoryRecord = {
    id: "prefix",
    parentId: null,
    timestamp: "t",
    type: "event",
    eventType: "claude.attachment",
    overflow: {},
  };
  const auth: HistoryRecord = {
    id: "e6903b82-aaa5-408a-9275-c0f516275b2c",
    parentId: null,
    timestamp: "2026-10-06T21:00:53.762Z",
    type: "event",
    eventType: "claude.auth",
    custom: { customType: "claude.auth", display: true },
    content: [{ type: "text", text: "Claude subscription connected." }],
    overflow: { generation: 1 },
  };
  const snapshot: HarnessSnapshot = {
    orbId: "orb",
    runtimeInstanceId: "run",
    activity: "idle",
    session: { id: "session", overflow: {} },
    records: [prefix, auth],
    headId: auth.id,
  };
  for (const cursor of [null, prefix.id]) {
    const frames = computeSyncFrames(snapshot, null, cursor, "now");
    const frame = frames.find(
      (frame) => frame.type === "history.record" && frame.record.id === auth.id,
    );
    expect(frame).toMatchObject({
      type: "history.record",
      headId: auth.id,
      record: {
        id: auth.id,
        parentId: null,
        timestamp: auth.timestamp,
        type: "event",
        eventType: "claude.auth",
      },
    });
    expect(JSON.stringify(frame)).not.toContain("subscription connected");
    expect(JSON.stringify(frame)).not.toContain("custom");
    expect(JSON.stringify(frame)).not.toContain("generation");
  }
  expect(snapshot.records[1]).toEqual(auth);
});
