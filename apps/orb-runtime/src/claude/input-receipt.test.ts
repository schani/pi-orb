import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryRecord } from "@pi-orb/protocol";
import { afterEach, expect, it } from "vitest";
import { planBootNotification } from "../pi/boot-notification.ts";
import { claudeBootEntries } from "./boot-notification.ts";
import { ClaudeHistory, nativeHistoryFiles, type Provenance } from "./history.ts";
import { qualifyClaudeRestart } from "./restore.ts";

const timestamp = "2026-10-15T22:23:02.522Z";
const attachment = {
  type: "attachment",
  uuid: "attachment",
  parentUuid: null,
  sessionId: "session",
  isSidechain: false,
  timestamp,
  attachment: {
    type: "queued_command",
    source_uuid: "input",
    delivery_id: "delivery",
    prompt: "PRIVATE_PROMPT",
    origin: { kind: "human" },
  },
};
const consumed = {
  type: "queue-operation",
  operation: "remove",
  reason: "absorbed_mid_turn",
  commandUuid: "input",
  deliveryId: "delivery",
  sessionId: "session",
  timestamp,
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(
  rows: unknown[] = [attachment, consumed],
  provenance: Provenance | null = { messageIds: ["inbox"], operationId: "op" },
) {
  const dir = mkdtempSync(join(tmpdir(), "claude-input-receipt-"));
  dirs.push(dir);
  const path = join(dir, "root.jsonl");
  const source = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(path, source);
  const history = new ClaudeHistory(dir, "session", timestamp);
  if (provenance) history.correlate("input", provenance)._unsafeUnwrap();
  return { dir, path, source, history };
}
const state = { deliveries: { inbox: { uuid: "input", operationId: "op", submitted: true } } };

it("recovers a fully fingerprinted legacy index without a suffix, preserving bytes and every old identity", () => {
  const f = fixture();
  const records: HistoryRecord[] = [
    {
      id: "attachment",
      parentId: null,
      timestamp,
      type: "event",
      eventType: "claude.attachment",
      overflow: { native: { type: "attachment", uuid: "attachment" } },
    },
    {
      id: "legacy-queue-id",
      parentId: "attachment",
      timestamp,
      type: "event",
      eventType: "claude.queue-operation",
      overflow: {},
    },
    {
      id: "final",
      parentId: "attachment",
      timestamp,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      finishReason: "end_turn",
      overflow: {},
    },
    {
      id: "result",
      parentId: "final",
      timestamp,
      type: "event",
      eventType: "claude.handoff_result",
      overflow: { operationId: "op", subtype: "success" },
    },
  ];
  const fingerprints = f.source
    .trimEnd()
    .split("\n")
    .map((line) => createHash("sha256").update(line).digest("hex"));
  writeFileSync(join(f.dir, "index.json"), JSON.stringify({ records, fingerprints }));
  const history = new ClaudeHistory(f.dir, "session", "2026-10-16T00:00:00Z");
  const view = history.scan(f.path)._unsafeUnwrap();
  expect(view.slice(0, records.length)).toEqual(records);
  expect(view).toHaveLength(records.length + 1);
  const receipt = history.inputReceipt("input");
  expect(receipt).toMatchObject({
    type: "event",
    parentId: "result",
    eventType: "claude.input_receipt",
    inboxMessageIds: ["inbox"],
    overflow: {
      inputUuid: "input",
      deliveryId: "delivery",
      attachmentId: "attachment",
      operationId: "op",
      sessionId: "session",
      inputKind: "human",
    },
  });
  expect(receipt).not.toHaveProperty("content");
  expect(JSON.stringify(receipt)).not.toContain("PRIVATE_PROMPT");
  // Missing adapter terminal remains interrupted; a native result is not operation completion.
  expect(qualifyClaudeRestart(state, view, "host")._unsafeUnwrap().interruptedOperations).toEqual([
    "op",
  ]);
  const entries = claudeBootEntries(view);
  expect(entries).toMatchObject([
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
  ]);
  expect(
    planBootNotification(entries, entries, {
      runtimeInstanceId: "new",
      executionId: "new",
      incarnation: "1",
    }),
  ).toMatchObject({ marker: { details: { reason: "runtime_restarted" } } });
  const saved = readFileSync(join(f.dir, "index.json"), "utf8");
  const reopened = new ClaudeHistory(f.dir, "session", "2026-10-17T00:00:00Z");
  expect(reopened.scan(f.path)._unsafeUnwrap()).toEqual(view);
  expect(readFileSync(join(f.dir, "index.json"), "utf8")).toBe(saved);
  appendFileSync(
    f.path,
    JSON.stringify({ type: "assistant", uuid: "tail", message: { content: "tail" } }) + "\n",
  );
  expect(reopened.scan(f.path)._unsafeUnwrap().at(-1)?.id).toBe("tail");
  expect(reopened.inputReceipt("input")).toEqual(receipt);
  expect(readFileSync(f.path, "utf8").startsWith(f.source)).toBe(true);
});

it.each([
  [attachment],
  [consumed, attachment],
  [attachment, { ...consumed, deliveryId: "other" }],
  [attachment, { ...consumed, commandUuid: "other" }],
  [attachment, { ...consumed, reason: "delivered_to_agent" }],
  [{ ...attachment, sessionId: "child" }, consumed],
  [attachment, { ...consumed, sessionId: "child" }],
  [{ ...attachment, isSidechain: true }, consumed],
  [attachment, { ...consumed, isSidechain: true }],
  [{ ...attachment, agentId: "child" }, consumed],
  [{ ...attachment, attachment: { ...attachment.attachment, source_uuid: "" } }, consumed],
  [
    { ...attachment, attachment: { ...attachment.attachment, delivery_id: "x".repeat(97) } },
    consumed,
  ],
])("does not receipt incomplete, foreign or mismatched native proof: %j", (...rows) => {
  const f = fixture(rows);
  f.history.scan(f.path)._unsafeUnwrap();
  expect(f.history.inputReceipt("input")).toBeUndefined();
  expect(qualifyClaudeRestart(state, f.history.view, "host").isErr()).toBe(true);
});

it("requires trusted provenance, not native prompt/origin", () => {
  const f = fixture(undefined, null);
  f.history.scan(f.path)._unsafeUnwrap();
  expect(f.history.inputReceipt("input")).toBeUndefined();
  f.history.correlate("input", { messageIds: ["one", "two"], operationId: "op" })._unsafeUnwrap();
  f.history.scan(f.path)._unsafeUnwrap();
  expect(f.history.inputReceipt("input")).toMatchObject({ inboxMessageIds: ["one", "two"] });
});

it.each([
  { messageIds: ["one", "two"], operationId: "op" },
  {
    messageIds: ["peer"],
    operationId: "op",
    system: true,
    sender: { orbId: "11111111-1111-4111-8111-111111111111" },
  },
  { messageIds: ["system"], operationId: "op", system: true },
  { messageIds: [], operationId: "op", boot: true },
  { messageIds: [], operationId: "op", compaction: true },
])(
  "preserves trusted classification and never resets human budget for nonhuman input: %j",
  (provenance) => {
    const f = fixture(undefined, provenance);
    f.history.scan(f.path)._unsafeUnwrap();
    expect(f.history.inputReceipt("input")).toMatchObject({
      inboxMessageIds: provenance.messageIds,
    });
    const entries = claudeBootEntries(f.history.view);
    expect(entries).toHaveLength(
      "system" in provenance || "boot" in provenance || "compaction" in provenance ? 0 : 1,
    );
  },
);

it("rejects ambiguous pairs atomically", () => {
  for (const rows of [
    [
      attachment,
      consumed,
      {
        ...attachment,
        uuid: "other",
        attachment: { ...attachment.attachment, delivery_id: "other" },
      },
      { ...consumed, deliveryId: "other" },
    ],
    [attachment, consumed, { ...consumed, commandUuid: "other" }],
    [attachment, consumed, { ...attachment, uuid: "other" }],
  ]) {
    const f = fixture(rows);
    expect(f.history.scan(f.path).isErr()).toBe(true);
    expect(f.history.view).toEqual([]);
    expect(f.history.inputReceipt("input")).toBeUndefined();
  }
});

it.each(["commit", "sync", "malformed", "prefix"])(
  "failed %s exposes no new proof and retains old index",
  (failure) => {
    const f = fixture([attachment]);
    f.history.scan(f.path)._unsafeUnwrap();
    const index = readFileSync(join(f.dir, "index.json"), "utf8");
    appendFileSync(f.path, JSON.stringify(consumed) + "\n");
    if (failure === "malformed") appendFileSync(f.path, "null\n");
    if (failure === "prefix")
      writeFileSync(
        f.path,
        f.source.replace("PRIVATE_PROMPT", "CHANGED") + JSON.stringify(consumed) + "\n",
      );
    const history = new ClaudeHistory(f.dir, "session", timestamp, {
      ...nativeHistoryFiles,
      ...(failure === "commit" || failure === "sync"
        ? {
            [failure]: () => {
              throw new Error("injected");
            },
          }
        : {}),
    });
    expect(history.scan(f.path).isErr()).toBe(true);
    expect(history.inputReceipt("input")).toBeUndefined();
    expect(readFileSync(join(f.dir, "index.json"), "utf8")).toBe(index);
  },
);

it("waits for the complete consumption line, then reuses receipt across lost acknowledgements", () => {
  const f = fixture([attachment]);
  appendFileSync(f.path, JSON.stringify(consumed));
  f.history.scan(f.path)._unsafeUnwrap();
  expect(f.history.inputReceipt("input")).toBeUndefined();
  appendFileSync(f.path, "\n");
  const view = f.history.scan(f.path)._unsafeUnwrap();
  const reopened = new ClaudeHistory(f.dir, "session", "later");
  expect(reopened.scan(f.path)._unsafeUnwrap()).toEqual(view);
  expect(reopened.inputReceipt("input")).toEqual(f.history.inputReceipt("input"));
});

it("rejects a retained receipt whose proof conflicts on reopen", () => {
  const f = fixture();
  f.history.scan(f.path)._unsafeUnwrap();
  const index = JSON.parse(readFileSync(join(f.dir, "index.json"), "utf8"));
  index.records.at(-1).overflow.deliveryId = "forged";
  writeFileSync(join(f.dir, "index.json"), JSON.stringify(index));
  expect(new ClaudeHistory(f.dir, "session", timestamp).scan(f.path).isErr()).toBe(true);
});

it.each(["attachment", "input"])(
  "a late receipt cannot renew an exhausted budget after its original attachment: %s",
  (attachmentId) => {
    const f = fixture([{ ...attachment, uuid: attachmentId }, consumed]);
    const records = f.history.scan(f.path)._unsafeUnwrap();
    const attachmentRecord = records.find((record) => record.id === attachmentId)!;
    const receipt = f.history.inputReceipt("input")!;
    const claims: HistoryRecord[] = ["one", "two", "three"].map((id) => ({
      id,
      parentId: null,
      timestamp,
      type: "event",
      eventType: "pi-orb.turn-resume",
      overflow: { runtimeInstanceId: id, executionId: "old", incarnation: "0", reason: "resumed" },
    }));
    const assistant: HistoryRecord = {
      id: "tool",
      parentId: "attachment",
      timestamp,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_call", callId: "call", name: "Bash", arguments: {} }],
      finishReason: "tool_use",
      overflow: {},
    };
    const entries = claudeBootEntries([attachmentRecord, ...claims, assistant, receipt]);
    expect(
      planBootNotification(entries, entries, {
        runtimeInstanceId: "new",
        executionId: "new",
        incarnation: "1",
      }),
    ).toMatchObject({ triggerTurn: false, marker: { customType: "pi-orb.turn-resume-declined" } });
  },
);

it("a consumed UUID collision resets prior exhausted claims at the original attachment position", () => {
  const f = fixture([{ ...attachment, uuid: "input" }, consumed]);
  const records = f.history.scan(f.path)._unsafeUnwrap();
  const receipt = f.history.inputReceipt("input")!;
  expect(receipt).toMatchObject({
    eventType: "claude.input_receipt",
    overflow: { inputUuid: "input", attachmentId: "input", inputKind: "human" },
  });
  const claims: HistoryRecord[] = ["one", "two", "three"].map((id) => ({
    id,
    parentId: null,
    timestamp,
    type: "event",
    eventType: "pi-orb.turn-resume",
    overflow: { runtimeInstanceId: id, executionId: "old", incarnation: "0", reason: "resumed" },
  }));
  const assistant: HistoryRecord = {
    id: "tool",
    parentId: "input",
    timestamp,
    type: "message",
    role: "assistant",
    content: [{ type: "tool_call", callId: "call", name: "Bash", arguments: {} }],
    finishReason: "tool_use",
    overflow: {},
  };
  const entries = claudeBootEntries([...claims, ...records.slice(0, -1), assistant, receipt]);
  expect(entries).toMatchObject([
    ...claims.map((claim) => ({ type: "custom_message", id: claim.id })),
    { type: "message", id: "input", message: { role: "user" } },
    { type: "message", id: "tool", message: { role: "assistant" } },
  ]);
  expect(
    planBootNotification(entries, entries, {
      runtimeInstanceId: "new",
      executionId: "new",
      incarnation: "1",
    }),
  ).toMatchObject({ triggerTurn: true, marker: { customType: "pi-orb.turn-resume" } });
});

it.each([{}, { native: { isMeta: true } }, { native: { isCompactSummary: true } }])(
  "suppresses receipt projection only for an already-projected ordinary human UUID: %j",
  (overflow) => {
    const f = fixture();
    const records = f.history.scan(f.path)._unsafeUnwrap();
    const human: HistoryRecord = {
      id: "input",
      parentId: null,
      timestamp,
      type: "message",
      role: "user",
      content: [{ type: "text", text: "ordinary" }],
      overflow,
    };
    expect(claudeBootEntries([...records, human])).toEqual([
      {
        type: "message",
        id: "input",
        message: { role: "user", content: "native" in overflow ? [] : human.content },
      },
    ]);
  },
);

it("keeps ordinary top-level UUID receipts unchanged", () => {
  const f = fixture([{ type: "user", uuid: "input", message: { content: "ordinary" } }]);
  const records = f.history.scan(f.path)._unsafeUnwrap();
  expect(records).toHaveLength(1);
  expect(f.history.inputReceipt("input")).toEqual(records[0]);
  expect(records[0]).toMatchObject({ type: "message", role: "user", inboxMessageIds: ["inbox"] });
});

it("an attachment colliding with the submitted UUID is not an ordinary input receipt", () => {
  const f = fixture([{ ...attachment, uuid: "input" }]);
  f.history.scan(f.path)._unsafeUnwrap();
  expect(f.history.inputReceipt("input")).toBeUndefined();
  expect(qualifyClaudeRestart(state, f.history.view, "host").isErr()).toBe(true);
});

it("rejects duplicate matching removals even when one precedes the attachment", () => {
  const f = fixture([consumed, attachment, consumed]);
  expect(f.history.scan(f.path).isErr()).toBe(true);
  expect(f.history.inputReceipt("input")).toBeUndefined();
  expect(f.history.view).toEqual([]);
});
