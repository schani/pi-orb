import { describe, expect, it } from "vitest";
import {
  createDisplayRecordProjector,
  projectDisplayRecord,
  projectDisplayRecords,
} from "./display.ts";
import type { HistoryRecord } from "./history.ts";

const notification: HistoryRecord = {
  id: "64ebf883-48ee-40d6-be6a-7611d5624723",
  parentId: "4779d632-2d6c-4c5e-a30c-7c67c6d0968c",
  timestamp: "t",
  type: "message",
  role: "user",
  content: [{ type: "text", text: "<task-notification>PRIVATE_CHILD_CANARY</task-notification>" }],
  overflow: {
    native: {
      type: "user",
      uuid: "64ebf883-48ee-40d6-be6a-7611d5624723",
      origin: { kind: "task-notification", producer: "session-task" },
      promptSource: "system",
      turnOrigin: "task_notification",
      queueSkipAttachments: true,
      userType: "external",
      message: { role: "user", content: "PRIVATE_CHILD_CANARY" },
    },
  },
};

describe("Claude task delivery display provenance", () => {
  it("hides immutable old normalized notifications in live and reconnect DTOs without child results", () => {
    const before = JSON.stringify(notification);
    const hidden = {
      id: notification.id,
      parentId: notification.parentId,
      timestamp: "t",
      type: "event",
      eventType: "claude.task_notification",
    };
    expect(projectDisplayRecord(notification)).toEqual(hidden);
    expect(createDisplayRecordProjector()(notification)).toEqual(hidden);
    expect(projectDisplayRecords([notification])).toEqual([hidden]);
    expect(JSON.stringify(notification)).toBe(before);
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE_CHILD_CANARY");
  });
  it("uses positive session-task origin, never XML or missing inbox receipts alone", () => {
    const cases: HistoryRecord[] = [
      { ...notification, overflow: {} },
      { ...notification, inboxMessageIds: ["human-inbox"] },
      { ...notification, overflow: { native: { type: "user", isSynthetic: true } } },
      {
        ...notification,
        overflow: {
          native: {
            type: "user",
            origin: { kind: "task-notification", subkind: "scheduled-trigger" },
          },
        },
      },
      {
        ...notification,
        overflow: {
          native: {
            type: "user",
            origin: {
              kind: "task-notification",
              producer: "session-task",
              subkind: "session-inbox",
            },
          },
        },
      },
    ];
    for (const record of cases)
      expect(projectDisplayRecord(record)).toMatchObject({
        type: "message",
        content: notification.content,
      });
    expect(
      projectDisplayRecord({ ...notification, content: [{ type: "text", text: "no XML at all" }] }),
    ).toMatchObject({ type: "event", eventType: "claude.task_notification" });
  });
});
