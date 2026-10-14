import { Check } from "typebox/value";
import { expect, it } from "vitest";
import {
  DeliverOrbMessageRequestSchema,
  DisplayRecordSchema,
  HistoryRecordSchema,
  OrbMessageSystemSchema,
  OrbMessageViewSchema,
  projectDisplayRecord,
} from "./index.ts";

const senderOrbId = "11111111-1111-4111-8111-111111111111";
const system = { kind: "orb_message", senderOrbId };
const content = [{ type: "text", text: "<script>literal peer text</script>" }];

it("carries exact peer provenance through delivery and pending schemas", () => {
  expect(Check(OrbMessageSystemSchema, system)).toBe(true);
  expect(Check(OrbMessageSystemSchema, { ...system, senderOrbId: senderOrbId.toUpperCase() })).toBe(
    true,
  );
  for (const invalid of [
    { kind: "orb_message" },
    { ...system, senderOrbId: null },
    { ...system, senderOrbId: "not-an-id" },
    { ...system, senderOrbId: "00000000-0000-0000-0000-000000000000" },
    { ...system, senderOrbId: "11111111-1111-4111-7111-111111111111" },
    { ...system, senderOrbId: "11111111-1111-9111-8111-111111111111" },
    { ...system, sleepUntil: "t" },
    { kind: "sleep_wake", senderOrbId },
    { kind: "sleep_expired", sleepUntil: "t", senderOrbId },
  ])
    expect(Check(OrbMessageSystemSchema, invalid)).toBe(false);
  expect(Check(OrbMessageSystemSchema, { kind: "sleep_wake", sleepUntil: "t" })).toBe(true);
  expect(Check(OrbMessageSystemSchema, { kind: "sleep_expired", sleepUntil: "t" })).toBe(true);
  expect(
    Check(DeliverOrbMessageRequestSchema, {
      v: 1,
      messageId: "id",
      messageIds: ["id"],
      content,
      system,
    }),
  ).toBe(true);
  expect(
    Check(OrbMessageViewSchema, {
      id: "id",
      orbId: "receiver",
      content,
      system,
      status: "queued",
      createdAt: "t",
      updatedAt: "t",
    }),
  ).toBe(true);
});

it("preserves peer attribution and literal content in public history and display", () => {
  const record = {
    id: "id",
    parentId: null,
    timestamp: "t",
    overflow: {},
    type: "event" as const,
    eventType: "orb.message",
    sender: { orbId: senderOrbId },
    content: [{ type: "text" as const, text: content[0]!.text }],
    inboxMessageIds: ["id"],
  };
  expect(Check(HistoryRecordSchema, record)).toBe(true);
  const display = projectDisplayRecord(record);
  expect(display).toMatchObject({
    type: "event",
    eventType: "orb.message",
    sender: { orbId: senderOrbId },
    content,
    inboxMessageIds: ["id"],
  });
  expect(Check(DisplayRecordSchema, display)).toBe(true);
});
