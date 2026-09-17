import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  DeliverOrbMessageRequestSchema,
  HistoryRecordSchema,
  OrbBootContextRequestSchema,
  OrbBootContextResponseSchema,
  OrbMessageViewSchema,
  OrbSleepRequestSchema,
  OrbSleepResponseSchema,
} from "./index.ts";

const system = { kind: "sleep_wake", sleepUntil: "2026-09-18T00:00:00.000Z" } as const;

describe("orb sleep protocol", () => {
  it("accepts only positive safe integer durations and closed responses", () => {
    expect(Check(OrbSleepRequestSchema, { v: 1, durationSeconds: 1 })).toBe(true);
    for (const durationSeconds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(Check(OrbSleepRequestSchema, { v: 1, durationSeconds })).toBe(false);
    expect(
      Check(OrbSleepResponseSchema, { v: 1, sleepId: "sleep-1", sleepUntil: system.sleepUntil }),
    ).toBe(true);
    expect(
      Check(OrbSleepResponseSchema, {
        v: 1,
        sleepId: "sleep-1",
        sleepUntil: system.sleepUntil,
        extra: true,
      }),
    ).toBe(false);
  });

  it("carries a singleton wake context and system provenance", () => {
    expect(Check(OrbBootContextRequestSchema, { v: 1 })).toBe(true);
    const context = {
      messageId: "sleep-1",
      messageIds: ["sleep-1"],
      content: [{ type: "text", text: "Sleep finished." }],
      system,
    };
    expect(Check(OrbBootContextResponseSchema, { v: 1, context })).toBe(true);
    expect(Check(OrbBootContextResponseSchema, { v: 1, context: null })).toBe(true);
    expect(Check(DeliverOrbMessageRequestSchema, { v: 1, ...context })).toBe(true);
    expect(
      Check(OrbMessageViewSchema, {
        id: "sleep-1",
        orbId: "orb-1",
        content: context.content,
        system,
        status: "queued",
        createdAt: system.sleepUntil,
        updatedAt: system.sleepUntil,
      }),
    ).toBe(true);
  });

  it("allows inbox identity on event records", () => {
    expect(
      Check(HistoryRecordSchema, {
        id: "e1",
        parentId: null,
        timestamp: system.sleepUntil,
        overflow: {},
        type: "event",
        eventType: "pi.custom_message",
        inboxMessageIds: ["sleep-1"],
      }),
    ).toBe(true);
  });
});
