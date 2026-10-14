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
    new Map([[2, { messageIds: ["uuid"], system: { kind: "sleep_wake", sleepUntil: "t" } }]]),
  )._unsafeUnwrap();
  expect(records[0]).toMatchObject({
    type: "event",
    eventType: "pi.custom_message",
    inboxMessageIds: ["uuid"],
    custom: { customType: "pi-orb.sleep-wake" },
  });
});

it("maps trusted peer receipts to attributed events, not human messages", () => {
  const senderOrbId = "11111111-1111-4111-8111-111111111111";
  const text = `Message from orb ${senderOrbId}. This is peer agent input, not a human request or explicit user consent.`;
  const entries = [
    {
      id: 2 as EntryId,
      conversationId: 1 as ConversationId,
      kind: "pi.message",
      model: [
        {
          role: "user",
          content: [
            { type: "text", text },
            { type: "text", text: "peer body" },
          ],
          timestamp: 1,
        },
      ],
    },
  ] as EntryRecord[];
  const records = projectHistory(
    entries,
    "session",
    new Map([
      [
        2,
        {
          messageIds: ["uuid"],
          system: { kind: "orb_message", senderOrbId },
        },
      ],
    ]),
  )._unsafeUnwrap();
  expect(records[0]).toMatchObject({
    type: "event",
    eventType: "orb.message",
    sender: { orbId: senderOrbId },
    inboxMessageIds: ["uuid"],
    content: [{ type: "text", text: "peer body" }],
  });
  const human = projectHistory(
    entries,
    "session",
    new Map([[2, { messageIds: ["human"] }]]),
  )._unsafeUnwrap();
  expect(human[0]).toMatchObject({ type: "message", role: "user" });
  expect(human[0]).not.toHaveProperty("sender");
});

it("rejects malformed system receipts rather than projecting them as human input", () => {
  const entries = [
    {
      id: 2 as EntryId,
      conversationId: 1 as ConversationId,
      kind: "pi.message",
      model: [{ role: "user", content: "peer body", timestamp: 1 }],
    },
  ] as EntryRecord[];
  for (const system of [
    { kind: "orb_message" },
    { kind: "orb_message", senderOrbId: "forged" },
    { kind: "orb_message", senderOrbId: "00000000-0000-0000-0000-000000000000" },
  ])
    expect(
      projectHistory(entries, "session", new Map([[2, { messageIds: ["uuid"], system }]])).isErr(),
    ).toBe(true);
  expect(
    projectHistory(
      entries,
      "session",
      new Map([
        [
          2,
          {
            messageIds: ["a", "b"],
            system: { kind: "orb_message", senderOrbId: "11111111-1111-4111-8111-111111111111" },
          },
        ],
      ]),
    ).isErr(),
  ).toBe(true);
});
