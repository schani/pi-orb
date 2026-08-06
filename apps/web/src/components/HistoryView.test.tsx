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

  it("renders persisted and live shell output as preformatted shell turns", () => {
    const shellRecord: HistoryRecord = {
      id: "shell-1",
      parentId: null,
      timestamp: "time-shell-1",
      type: "event",
      eventType: "pi.bash_execution",
      content: [{ type: "text", text: "npm test\npassing" }],
      overflow: {
        native: {
          type: "message",
          message: {
            role: "bashExecution",
            command: "npm test",
            output: "passing",
            exitCode: 2,
            cancelled: false,
            truncated: true,
            excludeFromContext: true,
          },
        },
      },
    };
    const html = renderToStaticMarkup(
      <HistoryView
        records={[shellRecord]}
        liveBlocks={[
          {
            blockId: "shell-live",
            blockType: "shell",
            text: "$ git status\nclean",
            revision: 2,
          },
        ]}
        tools={[]}
        busy
      />,
    );

    expect(html.match(/turn-shell/g)).toHaveLength(2);
    expect(html).toContain("$ npm test\npassing");
    expect(html).toContain("excluded from model context · exit 2 · output truncated");
    expect(html).toContain("$ git status\nclean");
    expect(html).not.toContain("<strong>passing</strong>");
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
  it("renders user, committed assistant, and streaming assistant text as Markdown", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          message("user", "user", "**formatted user markdown** and `user code`"),
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

    expect(html).toContain("<strong>formatted user markdown</strong> and <code>user code</code>");
    expect(html).toContain("<h2>Answer</h2>");
    expect(html).toContain("Use <strong>Markdown</strong> and <code>code</code>.");
    expect(html).toContain("A <strong>streaming</strong> response");
  });

  it("linkifies web URLs in Markdown and other chat prose without linking code or other schemes", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          message(
            "user",
            "user",
            "Open https://example.com/from-user, not ftp://example.com or **Markdown**.",
          ),
          message(
            "assistant",
            "assistant",
            "PR: https://github.com/schani/pi-orb/pull/1. Keep `https://example.com/code` literal.",
          ),
        ]}
        liveBlocks={[
          {
            blockId: "live-url",
            blockType: "text",
            text: "Docs: www.example.org/docs",
            revision: 1,
          },
        ]}
        tools={[]}
        busy={false}
      />,
    );

    expect(html).toContain(
      '<a href="https://example.com/from-user" target="_blank" rel="noopener noreferrer">https://example.com/from-user</a>,',
    );
    expect(html).toContain(
      '<a href="https://github.com/schani/pi-orb/pull/1" target="_blank" rel="noopener noreferrer">https://github.com/schani/pi-orb/pull/1</a>.',
    );
    expect(html).toContain(
      '<a href="http://www.example.org/docs" target="_blank" rel="noopener noreferrer">www.example.org/docs</a>',
    );
    expect(html).toContain("ftp://example.com");
    expect(html).not.toContain('href="ftp://example.com"');
    expect(html).toContain("<strong>Markdown</strong>");
    expect(html).toContain("<code>https://example.com/code</code>");
    expect(html).not.toContain('href="https://example.com/code"');
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
