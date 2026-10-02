import type { HistoryRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detailContext, displayRecord } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";
import type { PersistedToolCall } from "./ToolActivity.tsx";

const captured: PersistedToolCall[][] = [];
vi.mock("./ToolActivity.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ToolActivity.tsx")>();
  return {
    ...actual,
    ToolActivity: (props: Parameters<typeof actual.ToolActivity>[0]) => {
      if (props.persisted) captured.push([...props.persisted]);
      return <actual.ToolActivity {...props} />;
    },
  };
});

function message(
  id: string,
  role: "assistant" | "tool" | "user",
  content: Extract<HistoryRecord, { type: "message" }>["content"],
): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: `time-${id}`,
    type: "message",
    role,
    content,
    overflow: {},
  };
}
function call(id: string, name = "edit") {
  return { type: "tool_call" as const, callId: id, name, arguments: { path: id } };
}
function result(id: string, added: number) {
  return {
    type: "tool_result" as const,
    callId: id,
    added,
    removed: 0,
    content: [{ type: "text" as const, text: `output-${id}-${added}` }],
  };
}
function notice(id: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: `time-${id}`,
    type: "event",
    eventType: "pi.custom_message",
    custom: { customType: "status", display: true },
    content: [{ type: "text", text: "Interposed notice" }],
    overflow: {},
  };
}
function alert(id: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: `time-${id}`,
    type: "event",
    eventType: "pi.custom",
    alert: { message: "Interposed alert", requestId: id },
    content: [],
    overflow: {},
  };
}
function render(records: HistoryRecord[]) {
  return renderToStaticMarkup(
    <HistoryView
      records={records.map(displayRecord)}
      detailContext={detailContext()}
      liveBlocks={[]}
      tools={[]}
      busy={false}
    />,
  );
}
function pairs() {
  return captured.flat().map(({ call, callRecordId, result: matched, resultRecordId }) => ({
    callId: call.callId,
    callRecordId,
    resultKey: matched?.detailKey,
    resultRecordId,
  }));
}

beforeEach(() => {
  captured.length = 0;
});
describe("persisted tool pairing across display boundaries", () => {
  it.each([
    ["prose", [message("prose", "assistant", [{ type: "text", text: "Between calls" }])]],
    ["displayed notice", [notice("notice")]],
    ["alert", [alert("alert")]],
  ] as const)("pairs across %s without merging the display runs", (_label, between) => {
    const html = render([
      message("first", "assistant", [call("one")]),
      ...between,
      message("last", "tool", [result("one", 7)]),
    ]);
    expect(pairs()).toEqual([
      { callId: "one", callRecordId: "first", resultRecordId: "last", resultKey: "last:0" },
    ]);
    expect(html).toContain("tool-call-completed");
    expect(html).not.toContain("tool-call-running");
    expect(html).not.toContain("tool output");
    const boundary =
      _label === "prose"
        ? "Between calls"
        : _label === "alert"
          ? "Interposed alert"
          : "Interposed notice";
    expect(html.indexOf("tool-call-completed")).toBeLessThan(html.indexOf(boundary));
  });

  it("pairs interleaved IDs independently and consumes reused IDs in order", () => {
    const html = render([
      message("calls", "assistant", [call("one"), call("two")]),
      message("middle", "assistant", [{ type: "text", text: "Middle" }]),
      message("two-result", "tool", [result("two", 2)]),
      message("one-result", "tool", [result("one", 3)]),
      message("unmatched", "tool", [result("one", 4)]),
      message("again", "assistant", [call("one")]),
      message("again-result", "tool", [result("one", 5)]),
    ]);
    expect(pairs()).toEqual([
      {
        callId: "one",
        callRecordId: "calls",
        resultRecordId: "one-result",
        resultKey: "one-result:0",
      },
      {
        callId: "two",
        callRecordId: "calls",
        resultRecordId: "two-result",
        resultKey: "two-result:0",
      },
      {
        callId: "one",
        callRecordId: "again",
        resultRecordId: "again-result",
        resultKey: "again-result:0",
      },
    ]);
    expect(html).toContain("tool output");
    expect(html).not.toContain("tool-call-running");
  });

  it.each([
    ["user", message("boundary", "user", [{ type: "text", text: "New turn" }])],
    [
      "compaction",
      {
        id: "boundary",
        parentId: null,
        timestamp: "time-boundary",
        type: "compaction",
        summary: [{ type: "text", text: "summary" }],
        overflow: {},
      } as HistoryRecord,
    ],
  ])(
    "does not pair across a %s boundary and leaves unmatched results orphaned",
    (_label, boundary) => {
      const html = render([
        message("old", "assistant", [call("one")]),
        boundary,
        message("orphan", "tool", [result("one", 4)]),
      ]);
      expect(pairs()).toEqual([
        { callId: "one", callRecordId: "old", resultKey: undefined, resultRecordId: undefined },
      ]);
      expect(html).toContain("tool-call-running");
      expect(html).toContain("tool output");
    },
  );
});
