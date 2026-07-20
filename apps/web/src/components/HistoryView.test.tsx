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
});
