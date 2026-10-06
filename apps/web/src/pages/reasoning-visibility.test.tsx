import type { OutputPatchEvent } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HistoryView } from "../components/HistoryView.tsx";
import { detailContext } from "../testkit/display-fixtures.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it("renders only authoritative live reasoning visibility, not empty public bodies or headlines", () => {
  let state = initialState("orb");
  for (const reasoningVisible of [false, true, false, true]) {
    state = reducer(state, {
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
          contentIndex: 2,
          reasoningVisible,
          headline: "",
          revision: 1,
          patch: { type: "replace", text: "" },
        } as OutputPatchEvent,
      },
    });
    const html = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[...state.liveBlocks.values()]}
        tools={[]}
        busy={false}
        detailContext={detailContext()}
      />,
    );
    expect(html.includes('activity-rail-label">thinking')).toBe(reasoningVisible);
    expect(state.liveBlocks.get("thinking")).toMatchObject({ contentIndex: 2, reasoningVisible });
  }
});

it("matches retired disclosure aliases by source indices across filtered reasoning, never array order", () => {
  let state = initialState("orb");
  for (const [blockId, contentIndex, reasoningVisible] of [
    ["empty", 0, false],
    ["kept", 2, true],
    ["redacted", 3, true],
  ] as const) {
    state = reducer(state, {
      type: "frame",
      frame: {
        v: 1,
        at: "now",
        type: "runtime.event",
        event: {
          type: "output_patch",
          operationId: "operation",
          blockId,
          contentIndex,
          blockType: "reasoning",
          reasoningVisible,
          revision: 1,
          headline: "",
          patch: { type: "replace", text: "" },
        } as OutputPatchEvent,
      },
    });
  }
  state = reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "history.record",
      headId: "committed",
      retiredBlockIds: ["redacted", "empty", "kept"],
      record: {
        type: "message",
        id: "committed",
        parentId: null,
        timestamp: "now",
        role: "assistant",
        content: [
          { type: "text", text: "Prose" },
          { type: "reasoning", headline: "", detailKey: "committed:2" },
          { type: "reasoning", headline: "", detailKey: "committed:3", redacted: true },
        ],
      },
    },
  });
  expect([...state.detailAliases]).toEqual([
    ["committed:2", "kept"],
    ["committed:3", "redacted"],
  ]);
  expect(state.liveBlocks.size).toBe(0);
});
