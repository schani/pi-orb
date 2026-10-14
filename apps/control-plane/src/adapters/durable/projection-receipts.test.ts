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

it("projects only trusted notification placements, before human receipt enrichment, with public ancestry", () => {
  const payload = JSON.stringify({
    agent_id: "child-7",
    description: "Check",
    message: "literal <b>message</b>\nnext",
  });
  const entries = [2, 3, 4, 5].map((id) => ({
    id: id as EntryId,
    conversationId: 1 as ConversationId,
    kind: "pi.user",
    model: [{ role: "user" as const, content: payload, timestamp: id }],
  }));
  const records = projectHistory(
    entries,
    "session",
    new Map([[3, { messageIds: ["ordinary-inbox-receipt"] }]]),
    new Set([3, 5]),
  )._unsafeUnwrap();
  expect(records.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
    { id: "session:2", parentId: null },
    { id: "session:3", parentId: "session:2" },
    { id: "session:4", parentId: "session:3" },
    { id: "session:5", parentId: "session:4" },
  ]);
  expect(records[1]).toEqual({
    id: "session:3",
    parentId: "session:2",
    timestamp: new Date(3).toISOString(),
    type: "event",
    eventType: "pi.custom_message",
    overflow: {},
    custom: { customType: "subagent-notification", display: true },
    subagent: {
      kind: "notification",
      id: "child-7",
      description: "Check",
      message: "literal <b>message</b>\nnext",
    },
  });
  expect(records[0]).toMatchObject({
    type: "message",
    role: "user",
    content: [{ type: "text", text: payload }],
  });
  expect(records[2]).toMatchObject({ type: "message", role: "user" });
  expect(JSON.stringify(records)).not.toContain("ordinary-inbox-receipt");
});

it.each([
  "not JSON",
  "null",
  "[]",
  "{}",
  '{"agent_id":7,"description":"task","message":"body"}',
  '{"agent_id":"7","description":"task","message":null}',
])("rejects malformed trusted payload %s without exposing raw user input", (content) => {
  const result = projectHistory(
    [
      {
        id: 3 as EntryId,
        conversationId: 1 as ConversationId,
        kind: "pi.user",
        model: [{ role: "user", content, timestamp: 3 }],
      },
    ],
    "session",
    new Map(),
    new Set([3]),
  );
  expect(result.isErr()).toBe(true);
  expect(result._unsafeUnwrapErr()).toEqual({
    type: "history_mapping_error",
    code: "mapping_failure",
    message: "Invalid subagent notification placement",
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
