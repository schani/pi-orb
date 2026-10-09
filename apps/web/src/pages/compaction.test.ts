import type { OrbView } from "@pi-orb/protocol";
import { expect, it } from "vitest";
import {
  canRunComposerCommand,
  canSendComposer,
  initialState,
  isLiveBusy,
  isLiveCompacting,
  reducer,
} from "./OrbPage.tsx";

it("admits compact only on a synchronized running idle aggregate without mutations", () => {
  const state = {
    ...initialState("compact"),
    connection: "open" as const,
    synced: true,
    activity: "idle" as const,
    settings: {
      type: "agent_settings" as const,
      settings: { model: { provider: "test", id: "a" }, thinkingLevel: "high" as const },
      models: [],
      writable: true,
    },
  };
  expect(canRunComposerCommand("running", state)).toBe(true);
  for (const lifecycle of ["stopped", "starting", "archived"] as const)
    expect(canRunComposerCommand(lifecycle, state)).toBe(false);
  for (const patch of [
    { connection: "closed" as const },
    { synced: false },
    { activity: "busy" as const },
    { compacting: true },
    { settings: { ...state.settings, writable: false } },
    { pendingRequest: { requestId: "s", kind: "settings" as const } },
    { subagents: [{ id: "c", description: "child", phase: "running" as const }] },
  ])
    expect(canRunComposerCommand("running", { ...state, ...patch })).toBe(false);
});

it("queues ordinary inbox input while native compaction holds live command admission", () => {
  const state = {
    ...initialState("compact"),
    historyLoaded: true,
    compacting: true,
    activity: "busy" as const,
    pendingRequest: null,
  };
  expect(canSendComposer({ state: "running", centralAgent: false } as OrbView, state)).toBe(true);
  expect(canRunComposerCommand("running", state)).toBe(false);
});

it.each([
  ["running", "open", "busy", true, true],
  ["stopped", "open", "busy", true, false],
  ["failed", "open", "busy", true, false],
  ["running", "closed", "busy", true, false],
  ["running", "open", "idle", true, false],
  ["running", "open", "busy", false, false],
] as const)(
  "gates compaction progress by lifecycle and live authority (%s/%s/%s/%s)",
  (lifecycle, connection, activity, compacting, expected) => {
    const state = {
      ...initialState("compact"),
      connection,
      activity,
      compacting,
      compaction: { operationId: "compact", afterId: "before" },
    };
    expect(isLiveCompacting(lifecycle, state)).toBe(expected);
    expect(state.compaction).toEqual({ operationId: "compact", afterId: "before" });
  },
);

it("tracks compaction across sync and disconnect, and exposes failures", () => {
  let state = reducer(initialState("compact"), {
    type: "frame",
    frame: {
      v: 1,
      type: "runtime.event",
      at: "now",
      event: { type: "status", activity: "busy", operationId: "c", work: "compaction" },
    },
  });
  expect(state.compacting).toBe(true);
  expect(isLiveBusy("running", state)).toBe(false);
  state = reducer(state, { type: "connection_status", status: "closed" });
  expect(state.compacting).toBe(false);
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "runtime.event",
      at: "now",
      event: {
        type: "operation_finished",
        operationId: "c",
        outcome: "failed",
        message: "Summary failed",
      },
    },
  });
  expect(state.compacting).toBe(false);
  expect(state.serverError?.message).toBe("Summary failed");
});

it("compact completion relies on durable outcome history without a second notice", () => {
  let state = reducer(initialState("compact"), {
    type: "frame",
    frame: {
      v: 1,
      type: "runtime.event",
      at: "now",
      event: { type: "status", activity: "busy", operationId: "c", work: "compaction" },
    },
  });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "runtime.event",
      at: "now",
      event: {
        type: "operation_finished",
        operationId: "c",
        outcome: "failed",
        message: "Summary failed",
      },
    },
  });
  expect(state.compacting).toBe(false);
  expect(state.activity).toBe("idle");
  expect(state.serverError).toBeNull();
});

it("accepts a durable message receipt without ending held compaction", () => {
  let state = reducer(initialState("compact"), {
    type: "frame",
    frame: {
      v: 1,
      type: "runtime.event",
      at: "now",
      event: { type: "status", activity: "busy", operationId: "c", work: "compaction" },
    },
  });
  state = reducer(state, { type: "composer_changed", mode: "message", text: "queued input" });
  state = reducer(state, { type: "request_sent", requestId: "message", kind: "message" });
  expect(state.composerText).toBe("queued input");
  expect(state.compacting).toBe(true);
  state = reducer(state, { type: "message_enqueued", requestId: "message" });
  expect(state.composerText).toBe("");
  expect(state.pendingRequest).toBeNull();
  expect(state.compacting).toBe(true);
  expect(state.operationId).toBe("c");
  expect(canRunComposerCommand("running", state)).toBe(false);
});

it("compact entry preserves header-saved drafts on acceptance and cancellation", () => {
  let state = reducer(initialState("compact"), {
    type: "composer_changed",
    mode: "message",
    text: "keep draft",
  });
  state = reducer(state, { type: "open_settings", command: "model" });
  state = reducer(state, {
    type: "composer_changed",
    mode: "command",
    text: "compact keep decisions",
  });
  state = reducer(state, { type: "request_sent", requestId: "c", kind: "compact" });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "c",
      result: { type: "accepted", operationId: "c", duplicate: false },
    },
  });
  expect(state.composerText).toBe("keep draft");
  state = reducer(state, { type: "open_settings", command: "thinking" });
  state = reducer(state, { type: "composer_changed", mode: "command", text: "compact" });
  state = reducer(state, { type: "composer_changed", mode: "message", text: "" });
  expect(state.composerText).toBe("keep draft");
});

it("compact receipts preserve images and newer edits; rejection keeps command instructions", () => {
  let state = reducer(initialState("compact"), {
    type: "composer_changed",
    mode: "command",
    text: "compact preserve decisions",
  });
  state = reducer(state, {
    type: "image_added",
    image: { id: "i", mediaType: "image/png", data: "eA==" },
  });
  state = reducer(state, { type: "request_sent", requestId: "c", kind: "compact" });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "c",
      result: {
        type: "rejected",
        error: { code: "busy", message: "A child is running", retryable: true },
      },
    },
  });
  expect(state.composerText).toBe("compact preserve decisions");
  expect(state.requestError?.message).toBe("A child is running");
  state = reducer(state, { type: "request_sent", requestId: "c2", kind: "compact" });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "c2",
      result: { type: "accepted", operationId: "c2", duplicate: false },
    },
  });
  expect(state.composerText).toBe("");
  expect(state.composerMode).toBe("message");
  expect(state.composerImages).toHaveLength(1);
  state = reducer(state, { type: "composer_changed", mode: "command", text: "compact" });
  state = reducer(state, { type: "request_sent", requestId: "late", kind: "compact" });
  state = reducer(state, { type: "composer_changed", mode: "message", text: "new draft" });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "late",
      result: { type: "accepted", operationId: "late", duplicate: true },
    },
  });
  expect(state.composerText).toBe("new draft");
});
