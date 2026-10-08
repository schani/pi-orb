import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDisplayRecords } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { ClaudeHistory } from "./history.ts";

it("maps session-task deliveries to content-free events, preserving native bytes, IDs and human receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-task-notification-"));
  try {
    const file = join(dir, "root.jsonl");
    const notification = {
      type: "user",
      uuid: "64ebf883-48ee-40d6-be6a-7611d5624723",
      parentUuid: null,
      origin: { kind: "task-notification", producer: "session-task" },
      promptSource: "system",
      turnOrigin: "task_notification",
      queueSkipAttachments: true,
      userType: "external",
      message: {
        role: "user",
        content: "<task-notification>PRIVATE_CHILD_CANARY</task-notification>",
      },
    };
    const lines = [
      notification,
      { ...notification, uuid: "human", parentUuid: notification.uuid },
      { ...notification, uuid: "unknown", parentUuid: "human", origin: undefined },
      {
        ...notification,
        uuid: "scheduled",
        parentUuid: "unknown",
        origin: { kind: "task-notification", subkind: "scheduled-trigger" },
      },
    ];
    const native = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    writeFileSync(file, native);
    const history = new ClaudeHistory(dir, "session", "t");
    history.correlate("human", { messageIds: ["inbox"], operationId: "op" })._unsafeUnwrap();
    const records = history.scan(file)._unsafeUnwrap();
    expect(records[0]).toMatchObject({
      id: notification.uuid,
      parentId: null,
      type: "event",
      eventType: "claude.task_notification",
    });
    expect(JSON.stringify(records[0])).not.toContain("PRIVATE_CHILD_CANARY");
    expect(records[1]).toMatchObject({ type: "message", role: "user", inboxMessageIds: ["inbox"] });
    expect(records[2]).toMatchObject({ type: "message", role: "user" });
    expect(records[3]).toMatchObject({ type: "message", role: "user" });
    expect(projectDisplayRecords(records)[0]).toMatchObject({
      type: "event",
      eventType: "claude.task_notification",
    });
    const reopened = new ClaudeHistory(dir, "session", "t");
    expect(reopened.scan(file)._unsafeUnwrap()).toEqual(records);
    expect(readFileSync(file, "utf8")).toBe(native);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
