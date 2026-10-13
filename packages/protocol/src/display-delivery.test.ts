import { describe, expect, it } from "vitest";
import {
  createDisplayRecordProjector,
  projectDisplayRecord,
  projectDisplayRecords,
  projectRecordDetail,
} from "./display.ts";
import type { HistoryRecord } from "./history.ts";
import type { JsonObject } from "./json.ts";

const body =
  "<task-notification>\n<task-id>bdh1i4wbt</task-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish</summary>\n<note>PRIVATE_CHILD_CANARY</note>\n</task-notification>";

function userRecord(native: JsonObject | undefined, text = body): HistoryRecord {
  return {
    id: "delivery",
    parentId: "previous",
    timestamp: "t",
    type: "message",
    role: "user",
    content: [{ type: "text", text }],
    overflow: native === undefined ? {} : { native: { type: "user", ...native } },
  };
}

describe("non-human user-role deliveries", () => {
  it("projects receipt-less user messages as collapsed delivery rows with lazy detail", () => {
    const record = userRecord({ origin: { kind: "task-notification", producer: "session-task" } });
    const projected = {
      id: "delivery",
      parentId: "previous",
      timestamp: "t",
      type: "event",
      eventType: "agent.delivery",
      delivery: {
        kind: "task",
        headline: "Background shell command didn't finish",
        detailKey: "delivery:delivery",
      },
    };
    expect(projectDisplayRecord(record)).toEqual(projected);
    expect(createDisplayRecordProjector()(record)).toEqual(projected);
    expect(projectDisplayRecords([record])).toEqual([projected]);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_CHILD_CANARY");
    expect(projectRecordDetail(record, "delivery:delivery")).toEqual({
      type: "delivery",
      text: body,
    });
  });

  it("labels each delivery source from the native origin", () => {
    const cases: Array<[JsonObject | undefined, string]> = [
      [{ origin: { kind: "task-notification" }, queueTranscriptOnly: true }, "task"],
      [{ origin: { kind: "task-notification", subkind: "scheduled-trigger" } }, "scheduled"],
      [{ origin: { kind: "task-notification", subkind: "peer-send-message" } }, "peer"],
      [{ origin: { kind: "task-notification", subkind: "session-inbox" } }, "peer"],
      [{ isSynthetic: true }, "injected"],
      [undefined, "injected"],
    ];
    for (const [native, kind] of cases)
      expect(projectDisplayRecord(userRecord(native))).toMatchObject({
        type: "event",
        eventType: "agent.delivery",
        delivery: { kind },
      });
  });

  it("uses the first non-empty line when there is no summary", () => {
    expect(
      projectDisplayRecord(userRecord(undefined, "\n[Request interrupted by user]\nmore")),
    ).toMatchObject({ delivery: { kind: "injected", headline: "[Request interrupted by user]" } });
  });

  it("keeps inbox-correlated messages as human turns, even with notification text", () => {
    const human = {
      ...userRecord({ origin: { kind: "task-notification" } }),
      inboxMessageIds: ["inbox"],
    };
    expect(projectDisplayRecord(human)).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "text", text: body }],
      inboxMessageIds: ["inbox"],
    });
    expect(projectRecordDetail(human, "delivery:delivery")).toBeNull();
  });

  it("still hides native metadata entries and their text", () => {
    expect(projectRecordDetail(userRecord({ isMeta: true }), "delivery:delivery")).toBeNull();
    expect(projectDisplayRecord(userRecord({ isMeta: true }))).toEqual({
      id: "delivery",
      parentId: "previous",
      timestamp: "t",
      type: "event",
      eventType: "claude.native_metadata",
    });
  });

  it("shows retained content-free task notification events as non-expandable task rows", () => {
    expect(
      projectDisplayRecord({
        id: "old",
        parentId: null,
        timestamp: "t",
        type: "event",
        eventType: "claude.task_notification",
        overflow: { native: { type: "user", uuid: "old" } },
      }),
    ).toEqual({
      id: "old",
      parentId: null,
      timestamp: "t",
      type: "event",
      eventType: "agent.delivery",
      delivery: { kind: "task", headline: null },
    });
  });
});
