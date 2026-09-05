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
  it("gives each user record its own prefixed record and groups adjacent agent-side records", () => {
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

    expect(html.match(/rec rec-you/g)).toHaveLength(2);
    // a1 and t1 share one agent record; a2 (after u2) starts a new one.
    expect(html.match(/rec rec-orb/g)).toHaveLength(2);
    expect(html.match(/rec-px">you</g)).toHaveLength(2);
    expect(html.match(/rec-px">orb</g)).toHaveLength(2);
    expect(html).not.toContain("turn-mark");
  });

  it("renders an outstanding queued message once as a muted user turn", () => {
    const queued = {
      id: "00000000-0000-4000-8000-000000000123",
      orbId: "orb-1",
      content: [{ type: "text" as const, text: "queued while starting" }],
      status: "delivered" as const,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const queuedHtml = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        queuedMessages={[queued]}
      />,
    );
    expect(queuedHtml).toContain("rec rec-you rec-q");
    expect(queuedHtml).toContain('class="rec-status">delivered</span>');
    expect(queuedHtml).toContain("queued while starting");

    const committed = message("record-1", "user", "queued while starting");
    committed.overflow = {
      native: {
        type: "custom_message",
        customType: "pi-orb.user-message",
        details: { messageIds: [queued.id] },
      },
    };
    const committedHtml = renderToStaticMarkup(
      <HistoryView
        records={[committed]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        queuedMessages={[queued]}
      />,
    );
    expect(committedHtml).not.toContain("rec-q");
    expect(committedHtml.match(/queued while starting/g)).toHaveLength(1);
  });

  it("shows a message the runtime rejected as failed, with its reason", () => {
    const failed = {
      id: "00000000-0000-4000-8000-000000000126",
      orbId: "orb-1",
      content: [{ type: "text" as const, text: "a payload the runtime refuses" }],
      status: "failed" as const,
      error: "400 invalid_request: message payload too large",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
    };
    const html = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        queuedMessages={[failed]}
      />,
    );
    expect(html).toContain('class="rec-status">failed</span>');
    expect(html).toContain('class="error-text">400 invalid_request: message payload too large<');
    expect(html).toContain("a payload the runtime refuses");
  });

  it("places persisted and live reasoning disclosures on the orb activity rail", () => {
    const reasoningRecord: HistoryRecord = {
      id: "reasoning-record",
      parentId: null,
      timestamp: "time-reasoning",
      type: "message",
      role: "assistant",
      content: [{ type: "reasoning", text: "considering persisted evidence" }],
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView
        records={[reasoningRecord]}
        liveBlocks={[
          {
            blockId: "live-reasoning",
            blockType: "reasoning",
            text: "considering live evidence",
            revision: 1,
          },
        ]}
        tools={[]}
        busy
      />,
    );

    expect(html.match(/class="rec rec-orb"/g)).toHaveLength(1);
    expect(html.match(/class="rec-px">orb</g)).toHaveLength(1);
    expect(html.match(/class="activity-rail-row [^"]* reasoning"/g)).toHaveLength(2);
    expect(html.match(/activity-rail-label">thinking</g)).toHaveLength(2);
    expect(html).toContain("considering persisted evidence");
    expect(html).toContain("considering live evidence");
  });

  it("does not duplicate a live block that has already become persisted", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          {
            id: "persisted-reasoning",
            parentId: null,
            timestamp: "time-reasoning",
            type: "message",
            role: "assistant",
            content: [{ type: "reasoning", text: "same reasoning" }],
            overflow: {},
          },
        ]}
        liveBlocks={[
          {
            blockId: "live-reasoning",
            blockType: "reasoning",
            text: "same reasoning",
            revision: 1,
          },
        ]}
        tools={[]}
        busy
      />,
    );

    expect(html.match(/same reasoning/g)).toHaveLength(1);
    expect(html.match(/class="rec rec-orb"/g)).toHaveLength(1);
  });

  it("renders compaction as a full-width divider outside the prefixed records", () => {
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
    // The divider must close the preceding agent grouping context, not live inside a record.
    expect(html.match(/rec rec-orb/g)).toHaveLength(1);
  });

  it("renders persisted and live shell output as preformatted shell blocks", () => {
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

    expect(html.match(/rec rec-sh/g)).toHaveLength(2);
    expect(html).toContain('class="shblk-cmd">! npm test</div>');
    expect(html).toContain('class="shblk-out">passing</pre>');
    expect(html).toContain("excluded from model context · exit 2 · output truncated");
    expect(html).toContain("$ git status\nclean");
    expect(html).not.toContain("<strong>passing</strong>");
  });

  it("renders live streaming output, tool chips, and the busy cursor as an agent record", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[message("u1", "user", "go")]}
        liveBlocks={[{ blockId: "b1", blockType: "text", text: "streaming now", revision: 1 }]}
        tools={[{ callId: "call-1", name: "bash", state: "running", message: null }]}
        busy
      />,
    );

    expect(html.match(/rec rec-orb/g)).toHaveLength(1);
    expect(html.match(/rec-px">orb</g)).toHaveLength(1);
    expect(html).toContain("streaming now");
    expect(html).toContain("activity-rail-row-running tool-activity-category");
    expect(html).toContain('class="activity-rail-label">commands</span>');
    expect(html).toContain('class="cur"></span>');
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

  it("consolidates persisted tool calls and nests command output disclosures", () => {
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

    expect(html).toContain("activity-rail-row-completed tool-activity-category");
    expect(html).toContain('class="activity-rail-label">commands</span>');
    expect(html).toContain('class="activity-rail-headline" title="echo tool-input"');
    expect(html).not.toContain("1 command ran");
    expect(html).not.toContain("1 ran");
    expect(html).toContain('class="tool-command-text">echo tool-input</span>');
    expect(html).toContain('class="rec-px">run</span>');
    expect(html).toContain("✓ completed");
    expect(html).toContain("tool-output");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
    expect(html).not.toContain("live-tool-secret");
  });

  it("shows a singleton read's path instead of a count", () => {
    const records: HistoryRecord[] = [
      {
        id: "read-call-record",
        parentId: null,
        timestamp: "time-read-call",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "single-read",
            name: "read",
            arguments: { path: "a/very/long/path/to/HistoryView.tsx" },
          },
        ],
        overflow: {},
      },
      {
        id: "read-result-record",
        parentId: "read-call-record",
        timestamp: "time-read-result",
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "single-read",
            content: [{ type: "text", text: "source" }],
          },
        ],
        overflow: {},
      },
    ];

    const html = renderToStaticMarkup(
      <HistoryView records={records} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain(
      'class="activity-rail-headline" title="a/very/long/path/to/HistoryView.tsx"',
    );
    expect(html).not.toContain("1 file read");
  });

  it("distinguishes repeated reads of different ranges in the same file", () => {
    const records: HistoryRecord[] = [
      {
        id: "read-calls",
        parentId: null,
        timestamp: "time-read-calls",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "read-start",
            name: "read",
            arguments: { path: "provider.ts", offset: 1, limit: 180 },
          },
          {
            type: "tool_call",
            callId: "read-tail",
            name: "read",
            arguments: { path: "provider.ts", offset: 180, limit: 150 },
          },
        ],
        overflow: {},
      },
      {
        id: "read-start-result",
        parentId: "read-calls",
        timestamp: "time-read-start-result",
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "read-start",
            content: [{ type: "text", text: "first range" }],
          },
        ],
        overflow: {},
      },
      {
        id: "read-tail-result",
        parentId: "read-start-result",
        timestamp: "time-read-tail-result",
        type: "message",
        role: "tool",
        content: [
          {
            type: "tool_result",
            callId: "read-tail",
            content: [{ type: "text", text: "second range" }],
          },
        ],
        overflow: {},
      },
    ];

    const html = renderToStaticMarkup(
      <HistoryView records={records} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain('class="activity-rail-headline" title="provider.ts"');
    expect(html).not.toContain(">1 file</span>");
    expect(html).not.toContain("2 reads");
    expect(html).toContain("provider.ts:1–180");
    expect(html).toContain("provider.ts:180–329");
    expect(html).not.toContain("1 file read");
  });

  it("groups edit, command, and read calls on one activity rail with diff and failure totals", () => {
    const callRecord: HistoryRecord = {
      id: "calls",
      parentId: null,
      timestamp: "time-calls",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_call",
          callId: "edit-1",
          name: "edit",
          arguments: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] },
        },
        {
          type: "tool_call",
          callId: "bash-1",
          name: "bash",
          arguments: { command: "npm test" },
        },
        {
          type: "tool_call",
          callId: "bash-2",
          name: "bash",
          arguments: { command: "npm run typecheck" },
        },
        {
          type: "tool_call",
          callId: "read-1",
          name: "read",
          arguments: { path: "src/a.ts" },
        },
        {
          type: "tool_call",
          callId: "read-2",
          name: "read",
          arguments: { path: "src/b.ts" },
        },
      ],
      overflow: {},
    };
    const toolResult = (
      id: string,
      callId: string,
      text: string,
      isError = false,
      overflow: HistoryRecord["overflow"] = {},
    ): HistoryRecord => ({
      id,
      parentId: "calls",
      timestamp: `time-${id}`,
      type: "message",
      role: "tool",
      content: [{ type: "tool_result", callId, content: [{ type: "text", text }], isError }],
      overflow,
    });
    const records = [
      callRecord,
      toolResult("edit-result", "edit-1", "updated", false, {
        native: {
          message: {
            details: {
              patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra",
            },
          },
        },
      }),
      toolResult("bash-result-1", "bash-1", "one test failed", true),
      toolResult("bash-result-2", "bash-2", "typecheck passed"),
      toolResult("read-result-1", "read-1", "a source"),
      toolResult("read-result-2", "read-2", "b source"),
    ];

    const html = renderToStaticMarkup(
      <HistoryView records={records} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html.match(/class="activity-rail-row [^"]* tool-activity-category"/g)).toHaveLength(3);
    expect(html).toContain('class="activity-rail-headline" title="src/a.ts"');
    expect(html).not.toContain("1 file changed");
    expect(html).toContain("+2");
    expect(html).toContain("−1");
    expect(html).toContain("2 ran");
    expect(html).toContain("1 failed");
    expect(html).toContain("2 files");
    expect(html).toContain(">src/b.ts</code></summary>");
    expect(html).toContain("✕ failed");
    expect(html).toContain("one test failed");
  });
});
