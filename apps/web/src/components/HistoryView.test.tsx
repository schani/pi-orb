import type { HistoryRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

describe("HistoryView turn structure", () => {
  it("gives each user record its own gutter turn and groups adjacent agent-side records", () => {
    const records: HistoryRecord[] = [
      message("u1", "user", "first question"),
      message("a1", "assistant", "working on it"),
      {
        id: "t1",
        parentId: "a1",
        timestamp: "time-t1",
        overflow: { native: {} },
        type: "message",
        role: "tool",
        content: [
          { type: "tool_result", callId: "call-1", content: [{ type: "text", text: "output" }] },
        ],
      },
      message("u2", "user", "second question"),
      message("a2", "assistant", "answer two"),
    ];
    const html = renderToStaticMarkup(
      <HistoryView records={records} liveBlocks={[]} tools={[]} busy={false} />,
    );

    expect(html.match(/turn-user/g)).toHaveLength(2);
    // a1 and t1 share one agent turn; a2 (after u2) starts a new one.
    expect(html.match(/turn-agent/g)).toHaveLength(2);
    expect(html.match(/turn-mark">Y</g)).toHaveLength(2);
    expect(html.match(/turn-mark">O</g)).toHaveLength(2);
    expect(html).toContain(">You<");
    expect(html).toContain(">Orb<");
  });

  it("renders compaction as a full-width divider outside the gutter turns", () => {
    const records: HistoryRecord[] = [
      message("u1", "user", "hello"),
      {
        id: "c1",
        parentId: "u1",
        timestamp: "time-c1",
        overflow: { native: {} },
        type: "compaction",
        summary: [{ type: "text", text: "the summary" }],
      },
      message("a1", "assistant", "after compaction"),
    ];
    const html = renderToStaticMarkup(
      <HistoryView records={records} liveBlocks={[]} tools={[]} busy={false} />,
    );

    expect(html).toContain("context compacted");
    expect(html.match(/record-compaction/g)).toHaveLength(1);
    // The divider must close the preceding agent grouping context, not live inside a turn.
    expect(html.match(/turn-agent/g)).toHaveLength(1);
  });

  it("renders live streaming output and tool chips as an agent turn", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[message("u1", "user", "go")]}
        liveBlocks={[{ blockId: "b1", blockType: "text", text: "streaming now", revision: 1 }]}
        tools={[{ callId: "call-1", name: "bash", state: "running", message: null }]}
        busy
      />,
    );

    expect(html.match(/turn-agent/g)).toHaveLength(1);
    expect(html.match(/turn-mark">O</g)).toHaveLength(1);
    expect(html).toContain("streaming now");
    expect(html).toContain("tool-chip-running");
  });
});

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

  it("renders image blocks inline from base64 data or url, with a placeholder fallback", () => {
    const record = (
      id: string,
      content: Extract<HistoryRecord, { type: "message" }>["content"],
    ): HistoryRecord =>
      ({
        id,
        parentId: null,
        timestamp: `time-${id}`,
        overflow: { native: {} },
        type: "message",
        role: "user",
        content,
      }) as HistoryRecord;
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          record("with-data", [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }]),
          record("with-url", [{ type: "image", url: "https://example.com/pic.png" }]),
          record("bare", [{ type: "image" }]),
        ]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
      />,
    );
    expect(html).toContain('src="data:image/png;base64,aGVsbG8="');
    expect(html).toContain('src="https://example.com/pic.png"');
    expect(html).toContain("[image]");
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
