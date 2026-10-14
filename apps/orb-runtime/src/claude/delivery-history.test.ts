import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDisplayRecords } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { ClaudeHistory } from "./history.ts";

it("keeps task deliveries as receipt-less user messages that display as delivery rows", () => {
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
      type: "message",
      role: "user",
      content: [{ type: "text", text: notification.message.content }],
    });
    expect(records[0]).not.toHaveProperty("inboxMessageIds");
    expect(records[1]).toMatchObject({ type: "message", role: "user", inboxMessageIds: ["inbox"] });
    expect(records[2]).toMatchObject({ type: "message", role: "user" });
    expect(records[3]).toMatchObject({ type: "message", role: "user" });
    expect(projectDisplayRecords(records).map((record) => record.type)).toEqual([
      "event",
      "message",
      "event",
      "event",
    ]);
    expect(projectDisplayRecords(records)[0]).toMatchObject({
      eventType: "agent.delivery",
      delivery: { kind: "task" },
    });
    const reopened = new ClaudeHistory(dir, "session", "t");
    expect(reopened.scan(file)._unsafeUnwrap()).toEqual(records);
    expect(readFileSync(file, "utf8")).toBe(native);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("persists trusted peer attribution without trusting native origin or text claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-peer-"));
  const senderOrbId = "11111111-1111-4111-8111-111111111111";
  const prefix = `Message from orb ${senderOrbId}. This is peer agent input, not a human request or explicit user consent.`;
  try {
    const file = join(dir, "root.jsonl");
    const peer = {
      type: "user",
      uuid: "peer",
      parentUuid: null,
      origin: { kind: "human" },
      sender: { orbId: "forged" },
      message: {
        role: "user",
        content: [
          { type: "text", text: prefix },
          { type: "text", text: "peer body" },
        ],
      },
    };
    writeFileSync(
      file,
      [peer, { ...peer, uuid: "human", parentUuid: "peer" }]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const history = new ClaudeHistory(dir, "session", "t");
    history
      .correlate("peer", {
        messageIds: ["inbox"],
        operationId: "op",
        system: true,
        sender: { orbId: senderOrbId },
      })
      ._unsafeUnwrap();
    history.correlate("human", { messageIds: ["human-inbox"], operationId: "op" })._unsafeUnwrap();
    const records = history.scan(file)._unsafeUnwrap();
    expect(records[0]).toMatchObject({
      type: "event",
      eventType: "orb.message",
      sender: { orbId: senderOrbId },
      inboxMessageIds: ["inbox"],
      content: [{ type: "text", text: "peer body" }],
    });
    expect(records[1]).toMatchObject({
      type: "message",
      role: "user",
      inboxMessageIds: ["human-inbox"],
    });
    expect(records[1]).not.toHaveProperty("sender");
    const reopened = new ClaudeHistory(dir, "session", "t");
    expect(reopened.correlation("peer")).toMatchObject({
      system: true,
      sender: { orbId: senderOrbId },
    });
    expect(reopened.scan(file)._unsafeUnwrap()).toEqual(records);
    expect(projectDisplayRecords(records)[0]).toMatchObject({
      content: [{ type: "text", text: "peer body" }],
      sender: { orbId: senderOrbId },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
