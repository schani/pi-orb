import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "@pi-orb/protocol";
import { HistoryView } from "./HistoryView.tsx";

function message(id: string, role: "user" | "assistant", text: string): HistoryRecord {
  return {
    id,
    parentId: null,
    timestamp: `time-${id}`,
    overflow: { native: {} },
    type: "message",
    role,
    content: [{ type: "text", text }],
  };
}

describe("HistoryView", () => {
  it("renders committed and streaming assistant text as Markdown but keeps user text literal", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          message("user", "user", "**literal user markdown**"),
          message("assistant", "assistant", "## Answer\n\nUse **Markdown** and `code`."),
        ]}
        liveBlocks={[
          {
            blockId: "live-1",
            blockType: "text",
            text: "A **streaming** response",
            revision: 1,
          },
        ]}
        tools={[]}
        busy
      />,
    );

    expect(html).toContain("**literal user markdown**");
    expect(html).not.toContain("<strong>literal user markdown</strong>");
    expect(html).toContain("<h2>Answer</h2>");
    expect(html).toContain("Use <strong>Markdown</strong> and <code>code</code>.");
    expect(html).toContain("A <strong>streaming</strong> response");
  });

  it("collapses persisted tool inputs and outputs and omits live tool messages by default", () => {
    const records: HistoryRecord[] = [
      {
        id: "assistant-tool-call",
        parentId: null,
        timestamp: "time-call",
        overflow: { native: {} },
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "call-1",
            name: "bash",
            arguments: { command: "echo tool-input" },
          },
        ],
      },
      {
        id: "tool-result",
        parentId: "assistant-tool-call",
        timestamp: "time-result",
        overflow: { native: {} },
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "call-1",
            content: [{ type: "text", text: "tool-output" }],
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(
      <HistoryView
        records={records}
        liveBlocks={[]}
        tools={[
          {
            callId: "live-call",
            name: "read",
            state: "running",
            message: "live-tool-secret",
          },
        ]}
        busy
      />,
    );

    expect(html).toContain("<summary>→ bash</summary>");
    expect(html).toContain("<summary>tool output</summary>");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
    expect(html).not.toContain("live-tool-secret");
  });
});
