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
