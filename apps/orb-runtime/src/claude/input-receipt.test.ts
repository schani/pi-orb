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

it("recovers an already-indexed root without a suffix, preserving old records and native bytes", () => {
  const f = fixture([
    attachment,
    consumed,
    {
      type: "assistant",
      uuid: "final",
      parentUuid: "attachment",
      timestamp,
      message: { content: "done", stop_reason: "end_turn" },
    },
  ]);
  f.history.scan(f.path)._unsafeUnwrap();
  const indexPath = join(f.dir, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const records: HistoryRecord[] = index.records.filter(
    (record: HistoryRecord) =>
      record.type !== "event" || record.eventType !== "claude.input_receipt",
  );
  writeFileSync(indexPath, JSON.stringify({ ...index, records }));
  const history = new ClaudeHistory(f.dir, "session", "later");
  const view = history.scan(f.path)._unsafeUnwrap();
  expect(view.slice(0, records.length)).toEqual(records);
  expect(view).toHaveLength(records.length + 1);
  const receipt = history.inputReceipt("input");
  expect(receipt).toMatchObject({
    type: "event",
    parentId: "final",
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
  expect(qualifyClaudeRestart(state, view, "host")._unsafeUnwrap().interruptedOperations).toEqual([
    "op",
  ]);
  const entries = claudeBootEntries(view);
  expect(
    planBootNotification(entries, entries, {
      runtimeInstanceId: "new",
      executionId: "new",
      incarnation: "1",
    }),
  ).toMatchObject({ marker: { details: { reason: "runtime_restarted" } } });
  const saved = readFileSync(join(f.dir, "index.json"), "utf8");
  const reopened = new ClaudeHistory(f.dir, "session", "later still");
  expect(reopened.scan(f.path)._unsafeUnwrap()).toEqual(view);
  expect(readFileSync(join(f.dir, "index.json"), "utf8")).toBe(saved);
  const suffix = `${JSON.stringify({ type: "assistant", uuid: "tail", message: { content: "tail" } })}\n`;
  appendFileSync(f.path, suffix);
  expect(reopened.scan(f.path)._unsafeUnwrap().at(-1)?.id).toBe("tail");
  expect(reopened.inputReceipt("input")).toEqual(receipt);
  expect(readFileSync(f.path, "utf8")).toBe(f.source + suffix);
});

it.each([
  [attachment],
  [{ ...attachment, uuid: "input" }],
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

it.each([
  [null, undefined],
  [{ messageIds: ["one", "two"], operationId: "op" }, "human"],
  [
    {
      messageIds: ["peer"],
      operationId: "op",
      system: true,
      sender: { orbId: "11111111-1111-4111-8111-111111111111" },
    },
    "peer",
  ],
  [{ messageIds: ["system"], operationId: "op", system: true }, "system"],
  [{ messageIds: [], operationId: "op", boot: true }, "boot"],
  [{ messageIds: [], operationId: "op", compaction: true }, "compaction"],
] satisfies [Provenance | null, string | undefined][])(
  "uses saved provenance %j, never native prompt/origin",
  (provenance, kind) => {
    const f = fixture(undefined, provenance);
    f.history.scan(f.path)._unsafeUnwrap();
    expect(f.history.inputReceipt("input")?.overflow.inputKind).toBe(kind);
    if (provenance === null) expect(f.history.inputReceipt("input")).toBeUndefined();
    else
      expect(f.history.inputReceipt("input")).toMatchObject({
        inboxMessageIds: provenance.messageIds,
      });
    expect(claudeBootEntries(f.history.view)).toHaveLength(kind === "human" ? 1 : 0);
  },
);

it.each([
  [attachment, consumed, { ...attachment, uuid: "other" }],
  [attachment, consumed, { ...consumed, commandUuid: "other" }],
  [consumed, attachment, consumed],
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
])("rejects ambiguous proof atomically: %j", (...rows) => {
  const f = fixture(rows);
  expect(f.history.scan(f.path).isErr()).toBe(true);
  expect(f.history.view).toEqual([]);
});

it("publishes no receipt on failed commit, then recovers without replay", () => {
  const f = fixture([attachment]);
  f.history.scan(f.path)._unsafeUnwrap();
  const index = readFileSync(join(f.dir, "index.json"), "utf8");
  appendFileSync(f.path, `${JSON.stringify(consumed)}\n`);
  const failed = new ClaudeHistory(f.dir, "session", timestamp, {
    ...nativeHistoryFiles,
    commit: () => {
      throw new Error("injected");
    },
  });
  expect(failed.scan(f.path).isErr()).toBe(true);
  expect(failed.inputReceipt("input")).toBeUndefined();
  expect(readFileSync(join(f.dir, "index.json"), "utf8")).toBe(index);
  const reopened = new ClaudeHistory(f.dir, "session", timestamp);
  reopened.scan(f.path)._unsafeUnwrap();
  expect(reopened.inputReceipt("input")).toMatchObject({ inboxMessageIds: ["inbox"] });
});

it("rejects a retained receipt whose proof conflicts on reopen", () => {
  const f = fixture();
  f.history.scan(f.path)._unsafeUnwrap();
  const index = JSON.parse(readFileSync(join(f.dir, "index.json"), "utf8"));
  index.records.at(-1).overflow.deliveryId = "forged";
  writeFileSync(join(f.dir, "index.json"), JSON.stringify(index));
  expect(new ClaudeHistory(f.dir, "session", timestamp).scan(f.path).isErr()).toBe(true);
});

it.each(["attachment", "input"])("projects human receipt at original attachment %s", (id) => {
  const f = fixture([{ ...attachment, uuid: id }, consumed]);
  const records = f.history.scan(f.path)._unsafeUnwrap();
  const claim: HistoryRecord = {
    id: "claim",
    parentId: id,
    timestamp,
    type: "event",
    eventType: "pi-orb.turn-resume",
    overflow: { runtimeInstanceId: "old", executionId: "old", incarnation: "0", reason: "resumed" },
  };
  expect(claudeBootEntries([...records.slice(0, 1), claim, ...records.slice(1)])).toMatchObject([
    { id: "input", type: "message", message: { role: "user" } },
    { id: "claim" },
  ]);
  expect(claudeBootEntries([claim, ...records])).toMatchObject([
    { id: "claim" },
    { id: "input", type: "message", message: { role: "user" } },
  ]);
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
