import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { projectHistory } from "./projection.ts";

const message = (id: number, text: string): EntryRecord => ({
  id: id as EntryId,
  conversationId: 1 as ConversationId,
  kind: "pi.message",
  model: [{ role: "user", content: text, timestamp: id }],
});

it("omits hidden placed inputs and chains the next public record around them", () => {
  const entries = [
    message(2, "visible before"),
    message(3, "PRIVATE notification"),
    message(4, "visible after"),
  ];
  const records = projectHistory(entries, "session", new Map(), new Set([3]))._unsafeUnwrap();
  expect(records.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
    { id: "session:2", parentId: null },
    { id: "session:4", parentId: "session:2" },
  ]);
  expect(JSON.stringify(records)).not.toContain("PRIVATE notification");
});

it("a hidden latest native input does not become the public head", () => {
  const records = projectHistory(
    [message(2, "visible"), message(3, "PRIVATE notification")],
    "session",
    new Map(),
    new Set([3]),
  )._unsafeUnwrap();
  expect(records.at(-1)?.id).toBe("session:2");
});

it("hides even an entry with an ordinary inbox receipt", () => {
  const records = projectHistory(
    [message(3, "PRIVATE notification")],
    "session",
    new Map([[3, { messageIds: ["should-not-be-public"] }]]),
    new Set([3]),
  )._unsafeUnwrap();
  expect(records).toEqual([]);
});

it("does not redact ordinary model-authored text that quotes a notification", () => {
  const entry = message(4, "PRIVATE notification quoted");
  const records = projectHistory([entry], "session", new Map(), new Set([3]))._unsafeUnwrap();
  expect(JSON.stringify(records)).toContain("PRIVATE notification quoted");
});
