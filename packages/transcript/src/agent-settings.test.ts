import { expect, it } from "vitest";
import { initialState, reducer } from "./state.ts";

const event = {
  type: "agent_settings" as const,
  settings: { model: { provider: "test", id: "a" }, thinkingLevel: "high" as const },
  models: [],
  writable: true,
};
it("settings events own the header; disconnect and old receipts cannot retain or regress it", () => {
  let state = reducer(initialState(), {
    type: "frame",
    frame: { v: 1, type: "runtime.event", at: "now", event },
  });
  expect(state.settings).toEqual(event);
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "old",
      result: { type: "settings_applied", duplicate: true },
    },
  });
  expect(state.settings).toEqual(event);
  state = reducer(state, { type: "connection_status", status: "closed" });
  expect(state.settings).toBeNull();
});
it("header command entry restores the draft and images on success but does not clear later edits", () => {
  let state = reducer(initialState(), {
    type: "composer_changed",
    mode: "message",
    text: "keep me",
  });
  state = reducer(state, { type: "open_settings", command: "model" });
  expect(state.composerText).toBe("model ");
  state = reducer(state, { type: "request_sent", requestId: "s", kind: "settings" });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "s",
      result: { type: "settings_applied", duplicate: false },
    },
  });
  expect(state.composerText).toBe("keep me");
  expect(state.composerMode).toBe("message");
  state = reducer(state, {
    type: "image_added",
    image: { id: "image", mediaType: "image/png", data: "eA==" },
  });
  state = reducer(state, { type: "open_settings", command: "thinking" });
  state = reducer(state, { type: "request_sent", requestId: "late", kind: "settings" });
  state = reducer(state, { type: "composer_changed", mode: "command", text: "thinking high" });
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "late",
      result: { type: "settings_applied", duplicate: false },
    },
  });
  expect(state.composerText).toBe("thinking high");
  expect(state.composerImages.map((image) => image.id)).toEqual(["image"]);
  state = reducer(state, { type: "composer_changed", mode: "message", text: "" });
  expect(state.composerText).toBe("keep me");
});
