import { CLAUDE_MODEL_CALL_EVENT, type HistoryRecord } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { claudeModelCall } from "./model-usage.ts";

const event = (overflow: object, eventType = CLAUDE_MODEL_CALL_EVENT): HistoryRecord => ({
  id: "r",
  parentId: null,
  timestamp: "2026-10-14T00:00:01.000Z",
  type: "event",
  eventType,
  content: [{ type: "text", text: "" }],
  custom: { customType: eventType, display: false },
  overflow: overflow as HistoryRecord["overflow"],
});
const call = {
  at: "2026-10-14T00:00:00.500Z",
  model: "claude-opus-5-5",
  querySource: "sdk",
  outcome: "ok",
  input: 3,
  output: 200,
  cacheRead: 40_000,
  cacheWrite: 1_500,
  costUsd: 0.042,
  durationMs: 4_100,
};

describe("claudeModelCall", () => {
  it("maps a call to a ledger row at its completion time", () => {
    expect(claudeModelCall(event(call))).toEqual({
      ...call,
      at: Date.parse(call.at),
      use: "root",
      provider: "anthropic",
      querySource: undefined,
    });
  });

  it.each([
    ["sdk", "root"],
    ["agent:builtin:general-purpose", "subagent"],
    ["agent:custom", "subagent"],
    ["compact", "compaction"],
    ["generate_session_title", "generate_session_title"],
    [undefined, "unknown"],
  ])("maps query_source %s to use %s", (querySource, use) => {
    expect(claudeModelCall(event({ ...call, querySource }))?.use).toBe(use);
  });

  it.each([
    ["another event", event(call, "claude.steering_result")],
    ["a string count", event({ ...call, input: "3" })],
    ["a fractional count", event({ ...call, input: 1.5 })],
    ["a negative count", event({ ...call, output: -1 })],
    ["an integer-column overflow", event({ ...call, cacheRead: 2 ** 31 })],
    ["an unparseable time", event({ ...call, at: "not a time" })],
  ])("ignores %s", (_, record) => {
    expect(claudeModelCall(record)).toBeNull();
  });
});
