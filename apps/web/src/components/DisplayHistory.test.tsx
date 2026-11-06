import type { DisplayRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { detailContext, messageNotice } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";

const base = {
  id: "r",
  parentId: null,
  timestamp: "2026-10-02T00:00:00Z",
  type: "message" as const,
  role: "assistant",
};

describe("browser summary rendering", () => {
  it("renders every call's summary in its strip dot; capped label equals heading", () => {
    const headline = `${"é".repeat(510)}…`;
    const records: DisplayRecord[] = [
      {
        ...base,
        content: [
          {
            type: "tool_call",
            callId: "a",
            name: "bash",
            headline,
            detailKey: "r:0",
          },
          {
            type: "tool_call",
            callId: "b",
            name: "bash",
            headline: "other",
            detailKey: "r:1",
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        detailContext={detailContext()}
      />,
    );
    expect(html).toContain(`aria-label="commands · ${headline}"`);
    expect(html).toContain('aria-label="commands · other"');
  });
  it("keeps a compact child message in the native activity rail", () => {
    const records = [messageNotice("Actual child message", "notice", "child", "Check deployment")];
    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        detailContext={detailContext()}
      />,
    );
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain("subagent-message-notice");
    expect(html).toContain('title="Actual child message">Actual child message</span>');
    expect(html).not.toContain("subagent-notice-body");
    expect(html).not.toContain("alert-band");
  });
  it("retains visible prose and failures while rendering reasoning as an empty disclosure", () => {
    const records: DisplayRecord[] = [
      {
        ...base,
        finishReason: "error",
        failure: { message: "bad model", providerTransportFailure: false },
        content: [
          { type: "text", text: "visible prose" },
          { type: "reasoning", headline: "", detailKey: "r:1" },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        detailContext={detailContext()}
      />,
    );
    expect(html).toContain("visible prose");
    expect(html).toContain("bad model");
    expect(html).toContain("thinking");
  });
});
