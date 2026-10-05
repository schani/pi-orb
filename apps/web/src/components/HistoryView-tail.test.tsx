import { type DisplayRecord, type HistoryRecord, projectDisplayRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { detailContext } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";

const comparators = vi.hoisted(
  () => new Map<string, (previous: unknown, next: unknown) => boolean>(),
);
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    memo: (...args: Parameters<typeof actual.memo>) => {
      if (typeof args[0] === "function" && args[1]) {
        comparators.set(args[0].name, args[1] as (previous: unknown, next: unknown) => boolean);
      }
      return actual.memo(...args);
    },
  };
});

function render(records: readonly DisplayRecord[]) {
  return renderToStaticMarkup(
    <HistoryView
      records={records}
      detailContext={detailContext()}
      liveBlocks={[]}
      tools={[]}
      busy={false}
    />,
  );
}

function alert(id: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: id,
    type: "event",
    eventType: "pi.custom",
    alert: { message: `ALERT-${id}`, requestId: id },
    content: [],
    overflow: {},
  };
}

function toolRecords() {
  const call = projectDisplayRecord({
    ...message("call", "assistant"),
    content: [{ type: "tool_call", callId: "one", name: "edit", arguments: {} }],
  });
  const result = projectDisplayRecord({
    ...message("result", "assistant"),
    parentId: "call",
    role: "tool",
    content: [{ type: "tool_result", callId: "one", content: [{ type: "text", text: "DONE" }] }],
  });
  return { call, result };
}

function message(
  id: string,
  role: "user" | "assistant",
): Extract<HistoryRecord, { type: "message" }> {
  return {
    id,
    parentId: null,
    timestamp: id,
    type: "message",
    role,
    content: [{ type: "text", text: `CONTENT-${id}` }],
    overflow: {},
  };
}

describe("tail-first history", () => {
  it("suppresses a queued duplicate represented only by a hidden older inbox record", () => {
    const queued = {
      id: "00000000-0000-4000-8000-000000000123",
      orbId: "orb",
      content: [{ type: "text" as const, text: "HIDDEN-QUEUED" }],
      status: "queued" as const,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const older = projectDisplayRecord({
      ...message("older", "user"),
      inboxMessageIds: [queued.id],
    });
    const records = [
      older,
      ...Array.from({ length: 20 }, (_, i) => projectDisplayRecord(message(`u${i}`, "user"))),
    ];
    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        detailContext={detailContext()}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        queuedMessages={[queued]}
      />,
    );
    expect(html).not.toContain("CONTENT-older");
    expect(html).not.toContain("HIDDEN-QUEUED");
    expect(html).not.toContain("rec-q");
    expect(html.match(/<article/g)).toHaveLength(20);
  });

  it("pairs a hidden call with a visible result across grouped alert rows", () => {
    const { call, result } = toolRecords();
    const records = [
      call,
      ...Array.from({ length: 20 }, (_, i) => projectDisplayRecord(alert(`boundary${i}`))),
      result,
    ];
    const html = render(records);
    expect(html).not.toContain('data-history-row="call"');
    expect(html).toContain('data-history-row="result"');
    expect(html).not.toContain("tool output");
    expect(html).not.toContain("activity-rail-row-running");
  });

  it("admits appended result pairing changes for a memoized call while skipping unchanged immutable records", () => {
    const { call, result } = toolRecords();
    if (call.type !== "message" || result.type !== "message") throw new Error("Expected messages");
    const callBlock = call.content[0];
    const resultBlock = result.content[0];
    const boundary = projectDisplayRecord(alert("boundary"));
    const before = render([call, boundary]);
    expect(before).toContain("activity-rail-row-running");
    const after = render([call, boundary, result]);
    expect(after).toContain("activity-rail-row-completed");
    expect(after).not.toContain("activity-rail-row-running");
    expect(after).not.toContain("tool output");
    const compare = [...comparators].find(([name]) => /^AgentRecords\d*$/.test(name))?.[1];
    expect(compare).toBeDefined();
    const pending = { results: new Map(), pairedResults: new Set() };
    const completed = {
      results: new Map([[callBlock, { block: resultBlock, recordId: result.id }]]),
      pairedResults: new Set([resultBlock]),
    };
    expect(
      compare?.({ records: [call], pairing: pending }, { records: [call], pairing: completed }),
    ).toBe(false);
    expect(
      compare?.(
        { records: [call], pairing: completed },
        {
          records: [call],
          pairing: {
            results: new Map(completed.results),
            pairedResults: new Set(completed.pairedResults),
          },
        },
      ),
    ).toBe(true);
    const prose = projectDisplayRecord(message("prose", "assistant"));
    expect(
      compare?.({ records: [prose], pairing: pending }, { records: [prose], pairing: completed }),
    ).toBe(true);
  });
  it("mounts only the last 20 complete grouped rows, not the last 20 records", () => {
    const records = Array.from({ length: 30 }, (_, i) => [
      message(`u${i}`, "user"),
      message(`a${i}`, "assistant"),
      message(`b${i}`, "assistant"),
    ])
      .flat()
      .map(projectDisplayRecord);
    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        detailContext={detailContext()}
        liveBlocks={[]}
        tools={[]}
        busy={false}
      />,
    );
    expect(html.match(/<article/g)).toHaveLength(20);
    expect(html).not.toContain("CONTENT-u19");
    expect(html).toContain("CONTENT-u20");
    expect(html).toContain("CONTENT-a20");
    expect(html).toContain("CONTENT-b20");
    expect(html).toContain("CONTENT-b29");
    expect(html).not.toContain("Show earlier");
  });
});
