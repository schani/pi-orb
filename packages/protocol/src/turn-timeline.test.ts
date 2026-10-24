import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { piTurnStarts, TurnTimelineSchema, turnTimelinePath } from "./turn-timeline.ts";

const user = (id: string) => ({ id, type: "message", role: "user", inboxMessageIds: [id] });
const assistant = (id: string, finishReason?: string) => ({
  id,
  type: "message",
  role: "assistant",
  ...(finishReason === undefined ? {} : { finishReason }),
});
const tool = (id: string) => ({ id, type: "message", role: "tool" });
const event = (id: string) => ({ id, type: "event", inboxMessageIds: [id] });

describe("Pi turn boundaries", () => {
  it("starts a turn at a band delivered while idle and keeps steering bands in the running turn", () => {
    expect([
      ...piTurnStarts([
        user("u1"),
        assistant("a1", "toolUse"),
        tool("t1"),
        user("steer"),
        assistant("a2", "stop"),
        event("peer"),
        user("u2"),
        user("steer-before-reply"),
        assistant("a3", "error"),
        user("u3"),
        assistant("a4", "aborted"),
        user("u4"),
        assistant("a5", "length"),
        { id: "compaction", type: "compaction" },
        user("u5"),
      ]),
    ]).toEqual(["u1", "u2", "u3", "u4", "u5"]);
  });

  it("does not treat user records without an inbox receipt as bands", () => {
    expect([
      ...piTurnStarts([
        { id: "injected", type: "message", role: "user" },
        assistant("a1", "toolUse"),
        user("steer"),
      ]),
    ]).toEqual([]);
  });

  it("treats an assistant record without a stop reason as the end of a run", () => {
    expect([...piTurnStarts([user("u1"), assistant("a1"), user("u2")])]).toEqual(["u1", "u2"]);
  });
});

it("encodes both path segments and validates the closed response", () => {
  expect(turnTimelinePath("orb/1", "s:1")).toBe("/api/v1/orbs/orb%2F1/turns/s%3A1/timeline");
  expect(
    Check(TurnTimelineSchema, {
      start: 1,
      rows: [
        { kind: "model", id: "a", start: 1, end: 2, use: "root", model: "m", ttftMs: 1 },
        { kind: "tool", id: "t", start: 2, end: 3, name: "bash", nested: false, status: "ok" },
        { kind: "marker", id: "m", start: 3, marker: "alert", text: "x" },
      ],
    }),
  ).toBe(true);
  expect(
    Check(TurnTimelineSchema, {
      start: 1,
      rows: [{ kind: "marker", id: "m", start: 3, marker: "other" }],
    }),
  ).toBe(false);
});
