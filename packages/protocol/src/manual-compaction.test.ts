import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { projectDisplayRecord } from "./display.ts";
import { ClientActionSchema, RuntimeStatusEventSchema } from "./frames.ts";
import { HistoryRecordSchema } from "./history.ts";

it("validates compact instructions and compaction status without a shadow receipt", () => {
  expect(Check(ClientActionSchema, { type: "compact" })).toBe(true);
  expect(
    Check(ClientActionSchema, { type: "compact", customInstructions: "retain decisions" }),
  ).toBe(true);
  expect(Check(ClientActionSchema, { type: "compact", customInstructions: 1 })).toBe(false);
  expect(Check(ClientActionSchema, { type: "compact", abort: true })).toBe(false);
  expect(
    Check(RuntimeStatusEventSchema, {
      type: "status",
      activity: "busy",
      operationId: "op",
      work: "compaction",
    }),
  ).toBe(true);
});
it.each([null, "display-frontier"])("carries the admission frontier (%s)", (compactionAfterId) => {
  expect(
    Check(RuntimeStatusEventSchema, {
      type: "status",
      activity: "busy",
      operationId: "compact",
      work: "compaction",
      compactionAfterId,
    }),
  ).toBe(true);
});
it("rejects untyped admission frontiers", () => {
  expect(
    Check(RuntimeStatusEventSchema, {
      type: "status",
      activity: "busy",
      work: "compaction",
      compactionAfterId: 12,
    }),
  ).toBe(false);
});

it("makes durable compaction failure visible without inserting it into model context", () => {
  const record = {
    id: "failure",
    parentId: null,
    timestamp: "2026-10-05T12:00:00Z",
    type: "event" as const,
    overflow: {},
    eventType: "agent.compaction",
    compaction: {
      operationId: "op",
      outcome: "failed" as const,
      message: "Context compaction failed.",
    },
    content: [{ type: "text" as const, text: "Context compaction failed." }],
  };
  expect(Check(HistoryRecordSchema, record)).toBe(true);
  expect(projectDisplayRecord(record)).toMatchObject({
    type: "event",
    content: [{ type: "text", text: "Context compaction failed." }],
  });
});
