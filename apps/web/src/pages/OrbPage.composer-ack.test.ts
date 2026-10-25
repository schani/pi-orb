import { describe, expect, it } from "vitest";
import { initialState, reducer } from "./OrbPage.tsx";

const acknowledgements = [
  { type: "message_enqueued", requestId: "A" },
  {
    type: "frame",
    frame: {
      v: 1,
      type: "request.result",
      at: "now",
      requestId: "A",
      result: { type: "accepted", operationId: "A", duplicate: false },
    },
  },
] as const;

function submittedMessage() {
  const state = reducer(initialState("orb"), {
    type: "composer_changed",
    text: " A ",
    mode: "message",
  });
  return reducer(state, { type: "request_sent", requestId: "A", kind: "message" });
}

describe.each(acknowledgements)("composer acknowledgement $type", (ack) => {
  it("preserves draft B when message A is acknowledged", () => {
    let state = submittedMessage();
    state = reducer(state, { type: "composer_changed", text: "B", mode: "message" });
    state = reducer(state, ack);
    expect(state.composerText).toBe("B");
    expect(state.pendingRequest).toBeNull();
  });

  it("preserves attachment edits even when text and mode are unchanged", () => {
    let state = submittedMessage();
    const image = { id: "B", mediaType: "image/png", data: "eA==" };
    state = reducer(state, { type: "image_added", image });
    state = reducer(state, ack);
    expect(state.composerText).toBe(" A ");
    expect(state.composerImages).toEqual([image]);
  });

  it("preserves a mode change even when text and images are unchanged", () => {
    let state = submittedMessage();
    state = reducer(state, { type: "composer_changed", text: " A ", mode: "command" });
    state = reducer(state, ack);
    expect(state.composerText).toBe(" A ");
    expect(state.composerMode).toBe("command");
  });

  it("preserves a header picker and its saved draft", () => {
    const state = reducer(submittedMessage(), { type: "open_settings", command: "model" });
    const accepted = reducer(state, ack);
    expect(accepted.composerText).toBe("model ");
    expect(accepted.composerMode).toBe("command");
    expect(accepted.commandDraft).toEqual({ text: " A " });
  });

  it("clears an unchanged submitted draft, including attachments", () => {
    let state = submittedMessage();
    state = reducer(state, {
      type: "image_added",
      image: { id: "A", mediaType: "image/png", data: "eA==" },
    });
    state = reducer(state, { type: "request_sent", requestId: "A", kind: "message" });
    state = reducer(state, ack);
    expect(state.composerText).toBe("");
    expect(state.composerMode).toBe("message");
    expect(state.composerImages).toEqual([]);
    expect(state.pendingRequest).toBeNull();
  });
});
