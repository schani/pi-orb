import type { ServerFrame } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HistoryView } from "../components/HistoryView.tsx";
import { initialState, reducer } from "./OrbPage.tsx";

it("does not let HTTP jump ahead of an open socket even before its first output patch", () => {
  const state = reducer(initialState("orb"), { type: "connection_status", status: "open" });
  expect(
    reducer(state, {
      type: "history_refreshed",
      view: { orbId: "orb", session: null, cursor: "ahead", headId: "ahead", records: [] },
    }),
  ).toBe(state);
});

it("commits and retires output atomically without suppressing a later identical response", () => {
  let state = reducer(initialState("orb"), { type: "connection_status", status: "open" });
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
  // The HTTP repair channel must not race ahead of the live atomic handoff.
  state = reducer(state, {
    type: "history_refreshed",
    view: {
      orbId: "orb",
      session: null,
      cursor: "committed",
      headId: "committed",
      records: [
        {
          id: "committed",
          parentId: null,
          timestamp: base.at,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "MCP_CHECK_COMPLETE" }],
          overflow: {},
        },
      ],
    },
  });
  expect(state.records.has("committed")).toBe(false);
  expect(state.liveBlocks.size).toBe(1);
  expect(
    apply({
      ...base,
      type: "history.record",
      headId: "committed",
      retiredBlockIds: ["operation:message:0"],
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
  ).toBe(1);
  expect(state.records.size).toBe(1);
  expect(state.liveBlocks.size).toBe(0);
  expect(
    apply({
      ...base,
      type: "runtime.event",
      event: {
        type: "output_patch",
        operationId: "operation",
        blockId: "operation:next-message:0",
        blockType: "text",
        revision: 1,
        patch: { type: "append", text: "MCP_CHECK_COMPLETE" },
      },
    }),
  ).toBe(2);
  state = reducer(state, { type: "connection_status", status: "closed" });
  state = reducer(state, {
    type: "history_refreshed",
    view: {
      orbId: "orb",
      session: null,
      cursor: "committed",
      headId: "committed",
      records: [...state.records.values()],
    },
  });
  expect(state.records.size).toBe(1);
  expect(state.liveBlocks.size).toBe(0);
});
