import { expect, it } from "vitest";
import { initialState, reducer } from "./OrbPage.tsx";

it("new session and full sync reset disclosure ownership; ordinary append does not", () => {
  const first = initialState("orb");
  const welcome = reducer(first, {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "server.welcome",
      connectionId: "one",
      runtimeInstanceId: "runtime",
      orbId: "orb",
      sessionId: "old",
      capabilities: [],
      limits: { maxIncomingFrameBytes: 1, maxPromptBytes: 1 },
    },
  });
  const appended = reducer(welcome, {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "history.record",
      record: {
        id: "reused",
        parentId: null,
        timestamp: "now",
        type: "message",
        role: "assistant",
        content: [{ type: "reasoning", headline: "", detailKey: "reused:0" }],
      },
      headId: "reused",
      retiredBlockIds: [],
    },
  });
  expect(appended.detailScope).toBe(welcome.detailScope);
  const replaced = reducer(appended, {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "server.welcome",
      connectionId: "two",
      runtimeInstanceId: "runtime",
      orbId: "orb",
      sessionId: "new",
      capabilities: [],
      limits: { maxIncomingFrameBytes: 1, maxPromptBytes: 1 },
    },
  });
  expect(replaced.detailScope).toBeGreaterThan(appended.detailScope);
  const full = reducer(replaced, {
    type: "frame",
    frame: { v: 1, at: "now", type: "sync.started", mode: "full", afterRecordId: null },
  });
  expect(full.detailScope).toBeGreaterThan(replaced.detailScope);
  expect(full.detailAliases.size).toBe(0);
});

it("retired live reasoning identifies the immutable disclosure to refresh on commit", () => {
  const live = reducer(initialState("orb"), {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "runtime.event",
      event: {
        type: "output_patch",
        operationId: "operation",
        blockId: "thinking",
        blockType: "reasoning",

        revision: 1,
        patch: { type: "replace", text: "" },
      },
    },
  });
  const next = reducer(live, {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "history.record",
      record: {
        id: "committed",
        parentId: null,
        timestamp: "now",
        type: "message",
        role: "assistant",
        content: [{ type: "reasoning", headline: "", detailKey: "committed:0" }],
      },
      headId: "committed",
      retiredBlockIds: ["thinking"],
      detailAliases: [{ blockId: "thinking", detailKey: "committed:0" }],
    },
  });
  expect(next.detailAliases.get("committed:0")).toBe("thinking");
  expect(next.liveBlocks.has("thinking")).toBe(false);
});
