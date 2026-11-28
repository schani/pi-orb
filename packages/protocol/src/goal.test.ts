import { Check } from "typebox/value";
import { expect, it } from "vitest";
import {
  CAPABILITY_GOAL,
  ClientActionSchema,
  GOAL_OBJECTIVE_MAX_LENGTH,
  GOAL_REASON_MAX_LENGTH,
  type GoalView,
  RequestResultFrameSchema,
  RuntimeEventSchema,
} from "./index.ts";

it("accepts goal commands with an objective or a revision", () => {
  expect(CAPABILITY_GOAL).toBe("goal");
  expect(Check(ClientActionSchema, { type: "goal_set", objective: "Ship the fix" })).toBe(true);
  expect(Check(ClientActionSchema, { type: "goal_set", objective: "  \n\t" })).toBe(false);
  expect(Check(ClientActionSchema, { type: "goal_set", objective: "x", revision: "1" })).toBe(
    false,
  );
  for (const type of ["goal_pause", "goal_resume", "goal_clear"]) {
    expect(Check(ClientActionSchema, { type, revision: "1" })).toBe(true);
    expect(Check(ClientActionSchema, { type })).toBe(false);
    expect(Check(ClientActionSchema, { type, revision: "1", objective: "x" })).toBe(false);
  }
});

it("bounds objective and reason on the wire", () => {
  const objective = "🫐".repeat(GOAL_OBJECTIVE_MAX_LENGTH);
  const reason = "x".repeat(GOAL_REASON_MAX_LENGTH);
  const action = { type: "goal_set", objective };
  expect(Check(ClientActionSchema, action)).toBe(true);
  expect(Check(ClientActionSchema, { ...action, objective: `${objective}x` })).toBe(false);

  const goal: GoalView = { revision: "1", objective, status: "blocked", reason };
  const event = { type: "goal_state", goal };
  expect(Check(RuntimeEventSchema, event)).toBe(true);
  expect(Check(RuntimeEventSchema, { ...event, goal: { ...goal, reason: `${reason}x` } })).toBe(
    false,
  );
  expect(
    Check(RuntimeEventSchema, { ...event, goal: { ...goal, objective: `${objective}x` } }),
  ).toBe(false);
});

it("accepts nullable state and a distinct idempotent receipt", () => {
  expect(Check(RuntimeEventSchema, { type: "goal_state", goal: null })).toBe(true);
  expect(Check(RuntimeEventSchema, { type: "goal_state" })).toBe(false);
  for (const status of ["active", "paused", "blocked", "complete"]) {
    expect(
      Check(RuntimeEventSchema, {
        type: "goal_state",
        goal: { revision: "1", objective: "Ship the fix", status },
      }),
    ).toBe(true);
  }
  expect(
    Check(RequestResultFrameSchema, {
      v: 1,
      type: "request.result",
      at: new Date(0).toISOString(),
      requestId: "goal",
      result: { type: "goal_applied", duplicate: false },
    }),
  ).toBe(true);
});
