import type { ServerFrame } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HistoryView } from "../components/HistoryView.tsx";
import { initialState, reducer } from "./OrbPage.tsx";

it("renders the one-record streaming handoff as one, two, then one completion", () => {
  let state = initialState("orb");
  const base = { v: 1 as const, at: "2026-09-12T00:00:00Z" };
  const apply = (frame: ServerFrame) => {
    state = reducer(state, { type: "frame", frame });
    return renderToStaticMarkup(
      <HistoryView
        records={[...state.records.values()]}
        liveBlocks={[...state.liveBlocks.values()]}
        tools={[]}
        busy={true}
      />,
    ).match(/<p>MCP_CHECK_COMPLETE<\/p>/g)?.length;
  };
  expect(
    apply({
      ...base,
      type: "runtime.event",
      event: {
        type: "output_patch",
        operationId: "operation",
        blockId: "operation:message:0",
        blockType: "text",
        revision: 1,
        patch: { type: "append", text: "MCP_CHECK_COMPLETE" },
      },
    }),
  ).toBe(1);
  expect(
    apply({
      ...base,
      type: "history.record",
      headId: "committed",
      record: {
        id: "committed",
        parentId: null,
        timestamp: base.at,
        overflow: { native: {} },
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "MCP_CHECK_COMPLETE" }],
      },
    }),
  ).toBe(2);
  expect(state.records.size).toBe(1);
  expect(
    apply({
      ...base,
      type: "runtime.event",
      event: {
        type: "output_retired",
        operationId: "operation",
        blockIds: ["operation:message:0"],
      },
    }),
  ).toBe(1);
  expect(state.records.size).toBe(1);
  expect(state.liveBlocks.size).toBe(0);
});
