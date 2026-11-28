import type { GoalView, ServerFrame } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import { canManageGoal, initialState, reducer } from "./OrbPage.tsx";

const welcome = (capabilities: string[], sessionId = "session"): ServerFrame => ({
  v: 1,
  type: "server.welcome",
  at: "now",
  orbId: "orb",
  runtimeInstanceId: "runtime",
  sessionId,
  connectionId: "connection",
  capabilities,
  limits: { maxPromptBytes: 1000, maxIncomingFrameBytes: 2000 },
});
const running = { state: "running" } as const;
const goal: GoalView = { revision: "rev", objective: "Fix the issue", status: "active" };
const snapshot = (goal: GoalView | null): ServerFrame => ({
  v: 1,
  type: "runtime.event",
  at: "now",
  event: { type: "goal_state", goal },
});
const synchronized = { v: 1, type: "sync.completed", at: "now", headId: null } as const;
const applied = {
  v: 1,
  type: "request.result",
  at: "now",
  requestId: "goal-request",
  result: { type: "goal_applied", duplicate: false },
} as const;

function stateFor(capabilities: string[]) {
  let state = reducer(initialState("orb"), { type: "connection_status", status: "open" });
  state = reducer(state, { type: "frame", frame: welcome(capabilities) });
  return state;
}

it("requires capability, synchronized connection and a goal snapshot; retains a read-only goal while offline", () => {
  let state = stateFor(["goal"]);
  state = reducer(state, { type: "frame", frame: synchronized });
  expect(canManageGoal(running, state)).toBe(false);
  state = reducer(state, { type: "frame", frame: snapshot(goal) });
  expect(canManageGoal(running, state)).toBe(true);
  expect(canManageGoal({ state: "archived", centralAgent: true }, state)).toBe(false);
  state = reducer(state, { type: "connection_status", status: "retrying" });
  expect(state.goal).toEqual(goal);
  expect(canManageGoal(running, state)).toBe(false);
  state = reducer(state, { type: "frame", frame: welcome([]) });
  expect(state.goal).toBeNull();
  state = reducer(state, { type: "frame", frame: snapshot(goal) });
  expect(state.goal).toBeNull();
});

it.each([
  ["stopping", "manual"],
  ["stopped", "manual"],
  ["stopping", "sleep"],
  ["stopped", "sleep"],
] as const)("keeps passive goal snapshots read-only while %s (%s)", (lifecycle, stopReason) => {
  const orb = { state: lifecycle, centralAgent: true, stopReason };
  const synced = reducer(stateFor(["goal"]), { type: "frame", frame: synchronized });
  for (const observedGoal of [goal, null]) {
    const state = reducer(synced, { type: "frame", frame: snapshot(observedGoal) });
    expect(state.goal).toBe(observedGoal);
    expect(canManageGoal(orb, state)).toBe(false);
  }
});

it("allows changes on an idle-stopped central agent and before a scheduled sleep stops the orb", () => {
  let state = reducer(stateFor(["goal"]), { type: "frame", frame: synchronized });
  state = reducer(state, { type: "frame", frame: snapshot(goal) });
  const scheduled = { ...running, centralAgent: true, sleepUntil: "2026-09-17T01:00:00Z" };
  expect(canManageGoal(scheduled, state)).toBe(true);
  const idle = { state: "stopped", stopReason: "idle" } as const;
  expect(canManageGoal({ ...idle, centralAgent: true }, state)).toBe(true);
  expect(canManageGoal(idle, state)).toBe(false);
});

it("does not reuse a goal across sessions and needs a fresh snapshot after reconnecting", () => {
  let state = stateFor(["goal"]);
  state = reducer(state, { type: "frame", frame: snapshot(goal) });
  state = reducer(state, { type: "frame", frame: synchronized });
  state = reducer(state, { type: "connection_status", status: "open" });
  state = reducer(state, { type: "frame", frame: welcome(["goal"]) });
  state = reducer(state, { type: "frame", frame: synchronized });
  expect(state.goal).toBe(goal);
  expect(canManageGoal(running, state)).toBe(false);
  state = reducer(state, { type: "frame", frame: snapshot(null) });
  expect(canManageGoal(running, state)).toBe(true);
  state = reducer(state, { type: "frame", frame: snapshot(goal) });
  state = reducer(state, { type: "frame", frame: welcome(["goal"], "next") });
  expect(state.goal).toBeNull();
});

it("allows goal changes while busy and leaves a simultaneous abort untouched", () => {
  let state = stateFor(["abort", "goal"]);
  state = reducer(state, { type: "frame", frame: snapshot(goal) });
  state = reducer(state, { type: "frame", frame: synchronized });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "runtime.event",
      at: "now",
      event: { type: "status", activity: "busy" },
    },
  });
  state = reducer(state, { type: "composer_changed", text: "draft", mode: "message" });
  state = reducer(state, {
    type: "goal_request_sent",
    requestId: "goal-request",
    source: "drawer",
  });
  state = reducer(state, { type: "request_sent", requestId: "abort-request", kind: "abort" });
  expect(canManageGoal(running, state)).toBe(true);
  state = reducer(state, { type: "frame", frame: applied });
  expect(state.pendingRequest?.requestId).toBe("abort-request");
  expect(state.pendingGoalRequest).toBeNull();
  expect(state.composerText).toBe("draft");
  expect(state.goal).toBe(goal);
});

it("restores the prior message and keeps attachments on goal-command success", () => {
  let state = stateFor(["goal"]);
  state = reducer(state, { type: "composer_changed", text: "draft", mode: "message" });
  state = reducer(state, { type: "open_settings", text: "goal new" });
  const image = { id: "image", mediaType: "image/png", data: "eA==" };
  state = reducer(state, { type: "image_added", image });
  state = reducer(state, {
    type: "goal_request_sent",
    requestId: "goal-request",
    source: "command",
  });
  state = reducer(state, { type: "frame", frame: applied });
  expect(state.composerText).toBe("draft");
  expect(state.composerMode).toBe("message");
  expect(state.composerImages).toEqual([image]);
});

it("shows a goal rejection without changing the objective or current goal", () => {
  let state = stateFor(["goal"]);
  state = reducer(state, { type: "open_settings", text: "goal clear" });
  state = reducer(state, {
    type: "goal_request_sent",
    requestId: "goal-request",
    source: "command",
  });
  const message = "Use the goal drawer to clear the current goal.";
  state = reducer(state, {
    type: "frame",
    frame: {
      ...applied,
      result: { type: "rejected", error: { code: "invalid_request", message, retryable: false } },
    },
  });
  expect(state.composerText).toBe("goal clear");
  expect(state.goal).toBeNull();
  expect(state.goalError).toEqual({ source: "command", message });
  expect(state.pendingGoalRequest).toBeNull();
});

it("does not clear later text or another request when a goal command is acknowledged or lost", () => {
  let state = stateFor(["goal"]);
  state = reducer(state, { type: "open_settings", text: "goal new" });
  state = reducer(state, {
    type: "goal_request_sent",
    requestId: "goal-request",
    source: "command",
  });
  state = reducer(state, { type: "composer_changed", text: "goal edited", mode: "command" });
  expect(reducer(state, { type: "frame", frame: applied }).composerText).toBe("goal edited");
  state = reducer(state, { type: "request_sent", requestId: "abort-request", kind: "abort" });
  state = reducer(state, { type: "request_lost", requestId: "goal-request" });
  expect(state.composerText).toBe("goal edited");
  expect(state.pendingRequest?.requestId).toBe("abort-request");
  expect(state.pendingGoalRequest).toBeNull();
  expect(state.goalError).toMatchObject({ source: "command" });
});
