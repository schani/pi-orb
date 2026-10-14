import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { projectHistory } from "./projection.ts";

it("projects committed receipt enrichment with the native user entry", () => {
  const entries = [
    {
      id: 2 as EntryId,
      conversationId: 1 as ConversationId,
      kind: "pi.message",
      model: [{ role: "user", content: "wake", timestamp: 1 }],
    },
  ] as EntryRecord[];
  const records = projectHistory(
    entries,
    "session",
    new Map([[2, { messageIds: ["uuid"], system: { kind: "sleep_wake" } }]]),
  )._unsafeUnwrap();
  expect(records[0]).toMatchObject({
    type: "event",
    eventType: "pi.custom_message",
    inboxMessageIds: ["uuid"],
    custom: { customType: "pi-orb.sleep-wake" },
  });
});

it("excludes reserved entries before receipt enrichment, without redacting quoted text", () => {
  const entries = [2, 3, 4, 5].map((id) => ({
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind: "pi.message",
    model: [{ role: "user" as const, content: "PRIVATE notification", timestamp: id }],
  }));
  const records = projectHistory(
    entries,
    "session",
    new Map([[3, { messageIds: ["ordinary-inbox-receipt"] }]]),
    new Set([3, 5]),
  )._unsafeUnwrap();
  expect(records.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
    { id: "session:2", parentId: null },
    { id: "session:4", parentId: "session:2" },
  ]);
  expect(JSON.stringify(records)).not.toContain("ordinary-inbox-receipt");
  expect(JSON.stringify(records)).toContain("PRIVATE notification");
});
