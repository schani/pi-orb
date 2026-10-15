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
const ok = {
  outcome: "ok",
  at: "2026-10-14T00:00:00.500Z",
  model: "claude-opus-5-5",
  querySource: "sdk",
  input: 3,
  output: 200,
  cacheRead: 40_000,
  cacheWrite: 1_500,
  costUsd: 0.042,
  durationMs: 4_100,
  requestId: "req_1",
};

describe("claudeModelCall", () => {
  it.each([
    ["sdk", "root"],
    ["agent:builtin:general-purpose", "subagent"],
    ["agent:custom", "subagent"],
    ["agent:default", "subagent"],
    ["compact", "compaction"],
    ["generate_session_title", "generate_session_title"],
    ["web_search_tool", "web_search_tool"],
  ])("maps query_source %s to use %s", (querySource, use) => {
    expect(claudeModelCall(event({ ...ok, querySource }))?.use).toBe(use);
  });

  it("maps a successful call to a ledger row at its completion time", () => {
    expect(claudeModelCall(event(ok))).toEqual({
      at: Date.parse("2026-10-14T00:00:00.500Z"),
      use: "root",
      provider: "anthropic",
      model: "claude-opus-5-5",
      outcome: "ok",
      input: 3,
      output: 200,
      cacheRead: 40_000,
      cacheWrite: 1_500,
      costUsd: 0.042,
      durationMs: 4_100,
    });
  });

  it("records a failed attempt with zero tokens and no cost", () => {
    expect(
      claudeModelCall(
        event({
          outcome: "error",
          at: "2026-10-14T00:00:00.500Z",
          model: "claude-opus-5-5",
          error: "Overloaded",
          statusCode: "529",
        }),
      ),
    ).toEqual({
      at: Date.parse("2026-10-14T00:00:00.500Z"),
      use: "unknown",
      provider: "anthropic",
      model: "claude-opus-5-5",
      outcome: "error",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("ignores other records and malformed calls", () => {
    expect(claudeModelCall(event(ok, "claude.steering_result"))).toBeNull();
    expect(claudeModelCall(event({ ...ok, input: "3" }))).toBeNull();
    expect(claudeModelCall(event({ ...ok, input: 1.5 }))).toBeNull();
    expect(claudeModelCall(event({ ...ok, output: -1 }))).toBeNull();
    expect(claudeModelCall(event({ ...ok, cacheRead: 2 ** 31 }))).toBeNull();
    expect(claudeModelCall(event({ ...ok, at: "not a time" }))).toBeNull();
  });
});
