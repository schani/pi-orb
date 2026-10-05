import { type HistoryRecord, projectDisplayRecords } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectToolHeadline } from "../lib/activity-headline.ts";
import { detailContext } from "../testkit/display-fixtures.ts";
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
function render(records: HistoryRecord[], causal = false) {
  if (!causal)
    records = records.map((record, index) => ({
      ...record,
      parentId: records[index - 1]?.id ?? null,
    }));
  return renderToStaticMarkup(
    <HistoryView
      records={projectDisplayRecords(records)}
      detailContext={detailContext()}
      liveBlocks={[]}
      tools={[]}
      busy={false}
    />,
  );
}
function headlineSource(pair: PersistedToolCall | undefined) {
  return pair === undefined
    ? undefined
    : selectToolHeadline(pair.call, pair.callRecordId, pair.result, pair.resultRecordId);
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
  it("associates sibling reused IDs with their causal tool and outcome source", () => {
    const read = message("read", "assistant", [call("shared", "read")]);
    const child = message("child", "assistant", [call("shared", "subagent")]);
    const readResult = {
      ...message("read-result", "tool", [result("shared", 1)]),
      parentId: "read",
    };
    const childResult = {
      ...message("child-result", "tool", [result("shared", 2)]),
      parentId: "child",
    };
    render([read, child, readResult], true);
    expect(pairs()).toEqual([
      {
        callId: "shared",
        callRecordId: "read",
        resultRecordId: "read-result",
        resultKey: "read-result:0",
      },
      { callId: "shared", callRecordId: "child", resultRecordId: undefined, resultKey: undefined },
    ]);
    const readSource = headlineSource(captured.flat()[0]);
    captured.length = 0;
    render([read, child, readResult, childResult], true);
    expect(pairs()).toEqual([
      {
        callId: "shared",
        callRecordId: "read",
        resultRecordId: "read-result",
        resultKey: "read-result:0",
      },
      {
        callId: "shared",
        callRecordId: "child",
        resultRecordId: "child-result",
        resultKey: "child-result:0",
      },
    ]);
    expect(captured.flat()[1]?.result?.headline).toBeNull();
    expect(captured.flat()[0]?.result).not.toHaveProperty("headline");
    const [completedRead, completedChild] = captured.flat();
    expect(headlineSource(completedRead)).toEqual(readSource);
    expect(headlineSource(completedChild)).toEqual({
      recordId: "child-result",
      detailKey: "child-result:0",
      headline: null,
    });
  });

  it("uses ancestry rather than all-entry append order for resets and consumption", () => {
    const first = message("first", "assistant", [call("shared")]);
    const otherUser = message("other-user", "user", [{ type: "text", text: "Other branch" }]);
    const outcome = { ...message("outcome", "tool", [result("shared", 1)]), parentId: "first" };
    const duplicate = {
      ...message("duplicate", "tool", [result("shared", 2)]),
      parentId: "outcome",
    };
    const html = render([first, otherUser, outcome, duplicate], true);
    expect(pairs()).toEqual([
      {
        callId: "shared",
        callRecordId: "first",
        resultRecordId: "outcome",
        resultKey: "outcome:0",
      },
    ]);
    expect(html.match(/tool output/g)).toHaveLength(1);
  });

  it("uses the latest unconsumed ancestral call without reviving an older reused ID", () => {
    const html = render([
      message("older", "assistant", [call("shared", "read")]),
      message("latest", "assistant", [call("shared", "subagent")]),
      notice("noop"),
      message("outcome", "tool", [result("shared", 1), result("shared", 2)]),
    ]);
    expect(pairs()).toEqual([
      { callId: "shared", callRecordId: "older", resultRecordId: undefined, resultKey: undefined },
      {
        callId: "shared",
        callRecordId: "latest",
        resultRecordId: "outcome",
        resultKey: "outcome:0",
      },
    ]);
    expect(html.match(/tool output/g)).toHaveLength(1);
  });

  it("keeps nonempty headingless reasoning but omits empty projected rows", () => {
    const html = render([
      message("thoughts", "assistant", [
        { type: "reasoning", text: "" },
        { type: "reasoning", text: " \n\t " },
        { type: "reasoning", text: "Plain reasoning without a heading" },
        { type: "reasoning", text: "", redacted: true },
      ]),
    ]);
    expect(html.match(/activity-rail-label">thinking/g)).toHaveLength(2);
  });
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
    expect(html).toContain("activity-rail-row-completed");
    expect(html).not.toContain("activity-rail-row-running");
    expect(html).not.toContain("tool output");
    const boundary =
      _label === "prose"
        ? "Between calls"
        : _label === "alert"
          ? "Interposed alert"
          : "Interposed notice";
    expect(html.indexOf("activity-rail-row-completed")).toBeLessThan(html.indexOf(boundary));
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
    expect(html).not.toContain("activity-rail-row-running");
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
      expect(html).toContain("activity-rail-row-running");
      expect(html).toContain("tool output");
    },
  );
});
