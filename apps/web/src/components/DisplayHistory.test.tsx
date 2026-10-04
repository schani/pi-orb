import type { DisplayRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TranscriptCache } from "../lib/transcript-cache.ts";
import { HistoryView } from "./HistoryView.tsx";

const base = {
  id: "r",
  parentId: null,
  timestamp: "2026-10-02T00:00:00Z",
  type: "message" as const,
  role: "assistant",
};

describe("browser summary rendering", () => {
  it("shows every call in a group without fetching detail; capped title equals heading", () => {
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
    const read = vi.fn();
    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        detailContext={{
          orbId: "orb",
          sessionId: "session",
          connected: false,
          operationId: null,
          cache: new TranscriptCache(),
          getOwner: () => null,
          livePending: new Map(),
          committedPending: new Map(),
          imagePending: new Map(),
        }}
      />,
    );
    expect(html).toContain("2 ran");
    expect(html).toContain("other");
    expect(html).toContain(`title="${headline}"`);
    expect(read).not.toHaveBeenCalled();
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
        detailContext={{
          orbId: "orb",
          sessionId: "session",
          connected: false,
          operationId: null,
          cache: new TranscriptCache(),
          getOwner: () => null,
          livePending: new Map(),
          committedPending: new Map(),
          imagePending: new Map(),
        }}
      />,
    );
    expect(html).toContain("visible prose");
    expect(html).toContain("bad model");
    expect(html).toContain("thinking");
  });
});
