import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HistoryView } from "../components/HistoryView.tsx";
import { detailContext } from "../testkit/display-fixtures.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it("renders a headingless content-free reasoning patch without visibility metadata", () => {
  const state = reducer(initialState("orb"), {
    type: "frame",
    frame: {
      v: 1,
      at: "now",
      type: "runtime.event",
      event: {
        type: "output_patch",
        operationId: "operation",
        blockId: "opaque-thinking-id",
        blockType: "reasoning",
        headline: "",
        revision: 1,
        patch: { type: "replace", text: "" },
      },
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
  expect(html).toContain('activity-rail-label">thinking');
  expect(state.liveBlocks.get("opaque-thinking-id")).not.toHaveProperty("contentIndex");
});

it("applies explicit sparse out-of-order disclosure aliases without parsing opaque keys or live IDs", () => {
  let state = initialState("orb");
  for (const blockId of ["kept", "redacted"]) {
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
          blockType: "reasoning",
          revision: 1,
          headline: "",
          patch: { type: "replace", text: "" },
        },
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
      retiredBlockIds: ["redacted", "unknown-unsent-empty", "kept"],
      detailAliases: [
        { blockId: "redacted", detailKey: "opaque-redacted-detail" },
        { blockId: "kept", detailKey: "opaque-kept-detail" },
      ],
      record: {
        type: "message",
        id: "committed",
        parentId: null,
        timestamp: "now",
        role: "assistant",
        content: [
          { type: "text", text: "Prose" },
          { type: "reasoning", headline: "", detailKey: "opaque-kept-detail" },
          { type: "reasoning", headline: "", detailKey: "opaque-redacted-detail", redacted: true },
        ],
      },
    },
  });
  expect([...state.detailAliases]).toEqual([
    ["opaque-redacted-detail", "redacted"],
    ["opaque-kept-detail", "kept"],
  ]);
  expect(state.liveBlocks.size).toBe(0);
});
