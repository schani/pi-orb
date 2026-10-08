import { type HistoryRecord, projectRecordDetail } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mapPiEntry } from "../../../orb-runtime/src/pi/mapping.ts";
import {
  ComposedClaudeFixture,
  rootResult,
} from "../../../orb-runtime/src/testkit/claude-composed.ts";
import { detailContext, displayRecord } from "../testkit/display-fixtures.ts";
import { DetailContent } from "./DetailBody.tsx";
import {
  HistoryView as BrowserHistoryView,
  assistantResponseMarkdown as browserAssistantResponseMarkdown,
  type ToolChip,
} from "./HistoryView.tsx";

function HistoryView({
  records,
  ...props
}: Omit<ComponentProps<typeof BrowserHistoryView>, "records" | "detailContext"> & {
  records: readonly HistoryRecord[];
}) {
  return (
    <BrowserHistoryView
      {...props}
      records={records.map(displayRecord)}
      detailContext={detailContext()}
    />
  );
}
function assistantResponseMarkdown(record: Extract<HistoryRecord, { type: "message" }>) {
  const projected = displayRecord(record);
  if (projected.type !== "message") throw new Error("expected message projection");
  return browserAssistantResponseMarkdown(projected);
}

type MessageRecord = Extract<HistoryRecord, { type: "message" }>;

function message(id: string, role: "user" | "assistant", text: string): MessageRecord {
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

describe("HistoryView live tool status", () => {
  const call: MessageRecord = {
    ...message("execution-call", "assistant", ""),
    content: [
      { type: "tool_call", callId: "execution", name: "bash", arguments: { command: "pwd" } },
    ],
  };
  const waiting: ToolChip = {
    callId: "execution",
    name: "bash",
    state: "running",
    message: "Waiting for execution.",
  };
  const render = (records: HistoryRecord[], tool?: ToolChip) =>
    renderToStaticMarkup(
      <HistoryView records={records} liveBlocks={[]} tools={tool ? [tool] : []} busy={true} />,
    );

  it("updates the committed assistant call's one card when waiting arrives, then clears on ready", () => {
    const before = render([call]);
    expect(before).not.toContain("Waiting for execution.");
    const held = render([call], waiting);
    expect(held).toMatch(/<summary>[\s\S]*Waiting for execution\.[\s\S]*<\/summary>/);
    expect(held.match(/class="activity-rail-row/g)).toHaveLength(1);
    expect(held.match(/Waiting for execution\./g)).toHaveLength(1);
    expect(held).toContain("pwd");
    const ready = render([call], { ...waiting, message: null });
    expect(ready).not.toContain("Waiting for execution.");
    expect(ready).toContain("running");
    expect(ready.match(/class="activity-rail-row/g)).toHaveLength(1);
  });

  it.each([false, true])("committed outcome wins over stale waiting (isError=%s)", (isError) => {
    const result: MessageRecord = {
      ...message("execution-result", "assistant", ""),
      parentId: call.id,
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "execution",
          content: [{ type: "text", text: "outcome" }],
          isError,
        },
      ],
    };
    const html = render([call, result], waiting);
    expect(html).not.toContain("Waiting for execution.");
    expect(html).not.toContain("running");
    expect(html).toContain(isError ? "activity-rail-row-failed" : "activity-rail-row-completed");
    expect(html).not.toContain("outcome");
    expect(
      renderToStaticMarkup(
        <DetailContent
          context={detailContext()}
          recordId={result.id}
          detailKey={`${result.id}:0`}
          body={{ type: "tool_result", content: [{ type: "text", text: "outcome" }] }}
        />,
      ),
    ).toContain("outcome");
    expect(html.match(/class="activity-rail-row/g)).toHaveLength(1);
  });
});

describe("HistoryView turn structure", () => {
  it("shows compaction immediately in a disclosure without model thinking", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        compacting
        compaction={{ operationId: "compact", afterId: null }}
      />,
    );
    expect(html).toContain("activity-rail-row-running");
    expect(html).toContain('activity-rail-label">compacting');
    expect(html).not.toContain("bit-register");
    expect(html).not.toContain('activity-rail-label">thinking');
  });

  it("replaces progress with lazy canonical summary before the operation finishes", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          {
            id: "native-compact",
            parentId: null,
            timestamp: "now",
            overflow: {},
            type: "compaction",
            summary: [{ type: "text", text: "private canonical summary" }],
          },
        ]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        compacting
        compaction={{ operationId: "compact", afterId: null }}
      />,
    );
    expect(html.match(/activity-rail-row /g)).toHaveLength(1);
    expect(html).toContain('activity-rail-label">context compacted');
    expect(html).not.toContain('activity-rail-label">compacting');
    expect(html).not.toContain("private canonical summary");
  });
  it("shows nested command and read ranges inside the persisted codemode parent", () => {
    const call: MessageRecord = {
      ...message("codemode-call", "assistant", ""),
      content: [
        { type: "tool_call", callId: "parent", name: "codemode", arguments: { code: "run()" } },
      ],
    };
    const result: MessageRecord = {
      id: "codemode-result",
      parentId: call.id,
      timestamp: "later",
      type: "message",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "parent",
          content: [{ type: "text", text: "Parent output" }],
          nestedCalls: {
            complete: true,
            calls: [
              { id: "parent/1", name: "bash", status: "ok", arguments: { command: "pwd" } },
              { id: "parent/2", name: "read", status: "ok", arguments: { path: "a.ts" } },
              {
                id: "parent/3",
                name: "read",
                status: "ok",
                arguments: { path: "b.ts", offset: 10 },
              },
              {
                id: "parent/4",
                name: "read",
                status: "ok",
                arguments: { path: "c.ts", offset: 20, limit: 30 },
              },
            ],
          },
        },
      ],
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[call, result]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html.match(/class="activity-rail-row [^"]*tool-activity-category"/g)).toHaveLength(1);
    expect(html).not.toContain("Parent output");
    const body = projectRecordDetail(result, `${result.id}:0`);
    expect(body?.type).toBe("tool_result");
    if (body === null) throw new Error("missing projected detail");
    const detailHtml = renderToStaticMarkup(
      <DetailContent
        body={body}
        context={detailContext()}
        recordId={result.id}
        detailKey={`${result.id}:0`}
      />,
    );
    expect(detailHtml).toContain("Parent output");
    for (const detail of [
      "bash · ok",
      "read · ok",
      "&quot;command&quot;: &quot;pwd&quot;",
      "&quot;path&quot;: &quot;a.ts&quot;",
      "&quot;path&quot;: &quot;b.ts&quot;",
      "&quot;offset&quot;: 10",
      "&quot;path&quot;: &quot;c.ts&quot;",
      "&quot;offset&quot;: 20",
      "&quot;limit&quot;: 30",
    ]) {
      expect(detailHtml).toContain(detail);
    }
  });
  it("renders historical alerts as literal reverse bands, even after acknowledgement", () => {
    const record = {
      id: "alert-1",
      parentId: null,
      timestamp: "now",
      overflow: {},
      type: "event" as const,
      eventType: "pi.custom",
      alert: { message: "<script>\nlongword", requestId: "request-1" },
      content: [],
    } as HistoryRecord;
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain('class="rec rec-alert"');
    expect(html).toContain('class="alert-band"');
    expect(html).toContain("&lt;script&gt;\nlongword");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('role="alert"');
  });
  it("keeps adjacent reasoning and tool categories as sibling rail rows, splitting at prose", () => {
    const record: MessageRecord = {
      ...message("activity", "assistant", ""),
      content: [
        { type: "reasoning", text: "Plan" },
        { type: "tool_call", callId: "read-1", name: "read", arguments: { path: "a.ts" } },
        { type: "tool_call", callId: "edit-1", name: "edit", arguments: { path: "a.ts" } },
        { type: "text", text: "Explanation between runs" },
        { type: "reasoning", text: "Next plan" },
        { type: "tool_call", callId: "read-2", name: "read", arguments: { path: "b.ts" } },
      ],
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toMatch(
      /class="activity-rail-row[^"]*reasoning[^"]*"[\s\S]*?<\/details><details class="activity-rail-row[^"]*tool-activity-category/,
    );
    expect(html).toMatch(
      /class="activity-rail-row[^"]*tool-activity-category[^"]*"[\s\S]*?<\/details><details class="activity-rail-row[^"]*tool-activity-category/,
    );
    expect(html).toMatch(
      /Explanation between runs[\s\S]*?<\/div><details class="activity-rail-row[^"]*reasoning/,
    );
    expect(html).not.toContain("Next plan");
    expect(html).toContain('title="b.ts"');
  });
  it.each([
    [
      "subagent-notification",
      {
        kind: "notification" as const,
        status: "error",
        error: "Unsupported model",
        resultPreview: "No output.",
      },
      "Unsupported model",
    ],
    [
      "subagent-notification",
      {
        kind: "notification" as const,
        status: "completed",
        resultPreview: "Verified four services.",
      },
      "Verified four services.",
    ],
    [
      "subagent-update",
      { kind: "update" as const, message: "Checking deployment paths." },
      "Checking deployment paths.",
    ],
    [
      "subagent-workspace-notice",
      { kind: "workspace_notice" as const, notice: "Changes retained in the checkout." },
      "Changes retained in the checkout.",
    ],
  ])("renders %s receipt without machine XML or hidden body", (customType, subagent, text) => {
    const record: HistoryRecord = {
      id: "notice",
      parentId: null,
      timestamp: "2026-09-14T22:04:07Z",
      type: "event",
      eventType: "pi.custom_message",
      content: [
        { type: "text", text: "<task-notification>machine instructions</task-notification>" },
      ],
      custom: { customType, display: true },
      subagent: { id: "child", description: "Check deployment", ...subagent },
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain("Check deployment");
    expect(html).not.toContain(text);
    expect(html).not.toContain("subagent-notice-body");
    const body = renderToStaticMarkup(
      <DetailContent
        body={{ type: "subagent", ...subagent }}
        context={detailContext()}
        recordId="notice"
        detailKey="notice:0"
      />,
    );
    expect(body).toContain(text);
    expect(html).not.toContain("machine instructions");
  });

  it.each([undefined, 0, 1250, -1, Number.NaN])(
    "hides the internal subagent ID and body duration (%s)",
    (durationMs) => {
      const record: HistoryRecord = {
        id: "notice",
        parentId: null,
        timestamp: "time-notice",
        type: "event",
        eventType: "pi.custom_message",
        content: [],
        custom: { customType: "subagent-notification", display: true },
        subagent: {
          id: "private-child-identifier",
          description: "Check deployment",
          kind: "notification",
          status: "completed",
          resultPreview: "Done.",
          ...(durationMs === undefined ? {} : { durationMs }),
        },
        overflow: {},
      };
      const html = renderToStaticMarkup(
        <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
      );
      expect(html).not.toContain("private-child-identifier");
      expect(html).not.toContain("subagent-identity");
      expect(html).not.toContain("subagent-duration");
      expect(html).not.toContain("Done.");
    },
  );

  it("displays a mapped MCP custom status once without showing native payload", () => {
    const record: HistoryRecord = {
      id: "status",
      parentId: null,
      timestamp: "2026-09-29T00:00:00Z",
      type: "event",
      eventType: "pi.custom",
      content: [{ type: "text", text: "MCP posthog: needs-auth. Check project MCP settings." }],
      custom: { customType: "pi-orb:mcp-status", display: true },
      overflow: { native: { data: { message: "sensitive native payload" } } },
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html.match(/MCP posthog: needs-auth/g)).toHaveLength(1);
    expect(html).not.toContain("sensitive native payload");
  });

  it("ignores a subagent receipt that exists only in native overflow", () => {
    const record: HistoryRecord = {
      id: "notice",
      parentId: null,
      timestamp: "2026-09-14T22:04:07Z",
      type: "event",
      eventType: "pi.custom_message",
      content: [{ type: "text", text: "<task-notification>machine</task-notification>" }],
      overflow: {
        native: {
          customType: "subagent-notification",
          display: true,
          details: { id: "child", description: "Check deployment", status: "error" },
        },
      },
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).not.toContain("Check deployment");
    expect(html).not.toContain("machine");
  });
  it.each([
    [false, []],
    [true, []],
    [false, ["browser_transport_failure"]],
    [true, ["browser_transport_failure"]],
  ])("shows plain assistant failures with partial output: %s", (partial, diagnostics) => {
    const record: HistoryRecord = {
      ...message("failure", "assistant", ""),
      type: "message",
      role: "assistant",
      content: partial ? [{ type: "text", text: "Partial answer" }] : [],
      finishReason: "error",
      failure: { message: "Codex error: The usage limit has been reached", diagnostics },
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Codex error: The usage limit has been reached");
    expect(html).not.toContain("agent’s connection");
    expect(html.includes("Partial answer")).toBe(partial);
  });

  it("does not read failure wording from native overflow", () => {
    const record: HistoryRecord = {
      ...message("failure", "assistant", ""),
      type: "message",
      role: "assistant",
      content: [],
      finishReason: "error",
      overflow: {
        native: {
          message: {
            errorMessage: "Original error",
            diagnostics: [{ type: "provider_transport_failure" }],
          },
        },
      },
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain("Model response failed.");
    expect(html).not.toContain("Original error");
    expect(html).not.toContain("agent’s connection");
  });

  it.each([
    ["OpenAI", "openai-codex", "OpenAI"],
    ["unknown", "unknown-provider", "the model provider"],
    ["absent", undefined, "the model provider"],
  ])("labels %s transport failures without claiming recovery", (_name, provider, providerLabel) => {
    const record: HistoryRecord = {
      ...message("failure", "assistant", ""),
      type: "message",
      role: "assistant",
      model: { ...(provider === undefined ? {} : { provider }), id: "model-id" },
      content: [],
      finishReason: "error",
      failure: {
        message: "WebSocket closed 1006",
        diagnostics: ["provider_transport_failure"],
      },
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain(
      `The agent’s connection to ${providerLabel} was interrupted. WebSocket closed 1006`,
    );
    expect(html).not.toContain("retried");
    expect(html).not.toContain("recovered");
  });

  it.each([{}, { native: null }])(
    "shows a fallback when failure details are absent: %j",
    (overflow) => {
      const record: HistoryRecord = {
        ...message("failure", "assistant", ""),
        type: "message",
        role: "assistant",
        content: [],
        finishReason: "error",
        overflow,
      };
      const html = renderToStaticMarkup(
        <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
      );
      expect(html).toContain("Model response failed.");
    },
  );
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
    expect(html.match(/class="visually-hidden">You:<\/span>/g)).toHaveLength(2);
    expect(html.match(/class="visually-hidden">Orb:<\/span>/g)).toHaveLength(2);
    expect(html).not.toContain('class="rec-px">you');
    expect(html).not.toContain('class="rec-px">orb');
    expect(html).not.toContain("turn-mark");
  });

  it("renders an outstanding queued message once as a muted user turn", () => {
    const queued = {
      id: "00000000-0000-4000-8000-000000000123",
      orbId: "orb-1",
      content: [{ type: "text" as const, text: "queued while starting" }],
      status: "queued" as const,
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
    expect(queuedHtml).toContain('class="rec-status">queued</span>');
    expect(queuedHtml).toContain("queued while starting");

    const committed: MessageRecord = {
      ...message("record-1", "user", "queued while starting"),
      inboxMessageIds: [queued.id],
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

  it("renders system inbox notices without presenting them as human turns", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
        queuedMessages={[
          {
            id: "00000000-0000-4000-8000-000000000124",
            orbId: "orb-1",
            content: [{ type: "text", text: "Scheduled sleep ended." }],
            system: { kind: "sleep_wake", sleepUntil: "2026-09-17T01:00:00.000Z" },
            status: "queued",
            createdAt: "2026-09-17T01:00:00.000Z",
            updatedAt: "2026-09-17T01:00:00.000Z",
          },
        ]}
      />,
    );

    expect(html).toContain("Scheduled sleep ended.");
    expect(html).toContain("rec rec-orb rec-q");
    expect(html).not.toContain("rec rec-you rec-q");
    expect(html).not.toContain(">You:<");
  });

  it("identifies steering messages without dropping their content", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[]}
        tools={[]}
        busy
        queuedMessages={[
          {
            id: "00000000-0000-4000-8000-000000000125",
            orbId: "orb-1",
            content: [{ type: "text", text: "Please check the phone layout too." }],
            status: "delivered",
            delivery: "steer",
            operationId: "operation-1",
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:01.000Z",
          },
        ]}
      />,
    );
    expect(html).toContain('class="rec-status">steering</span>');
    expect(html).toContain("Please check the phone layout too.");
    expect(html).toContain('class="visually-hidden">You:</span>');
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
      content: [{ type: "reasoning", text: "# Persisted plan\n\nconsidering persisted evidence" }],
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView
        records={[reasoningRecord]}
        liveBlocks={[
          {
            blockId: "live-reasoning",
            blockType: "reasoning",
            text: "",
            headline: "Live plan",
            revision: 1,
          },
        ]}
        tools={[]}
        busy
      />,
    );

    expect(html.match(/class="rec rec-orb"/g)).toHaveLength(1);
    expect(html.match(/class="visually-hidden">Orb:<\/span>/g)).toHaveLength(1);
    expect(html.match(/class="activity-rail-row [^"]* reasoning"/g)).toHaveLength(2);
    expect(html.match(/activity-rail-label">thinking</g)).toHaveLength(2);
    expect(html).toContain(
      'class="activity-rail-headline" title="Persisted plan">Persisted plan</span>',
    );
    expect(html).toContain('class="activity-rail-headline" title="Live plan">Live plan</span>');
    expect(html).not.toContain("considering persisted evidence");
    expect(html).not.toContain("considering live evidence");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "reasoning", text: "considering persisted evidence" }}
          context={detailContext()}
          recordId="reasoning"
          detailKey="reasoning:0"
        />,
      ),
    ).toContain("considering persisted evidence");
  });

  it("does not hide a new live block merely because its text matches history", () => {
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

    expect(html).not.toContain("same reasoning");
    expect(html.match(/activity-rail-label">thinking/g)).toHaveLength(2);
    expect(html.match(/class="rec rec-orb"/g)).toHaveLength(1);
  });

  it.each([
    ["failed", "Context compaction failed: summary unavailable", true],
    ["failed", "Summary unavailable", true],
    ["failed", "Unable to shorten context", true],
    ["aborted", "Context compaction failed: cancelled by user", false],
    ["aborted", "Summary failed to finish before cancellation", false],
    ["aborted", "Context compaction cancelled.", false],
    ["aborted", "Compaction aborted", false],
  ] as const)(
    "renders mapped %s compaction once with failure-only red ink",
    (outcome, text, red) => {
      const mapped = mapPiEntry({
        id: "compact-outcome",
        parentId: null,
        timestamp: "now",
        type: "custom",
        customType: "pi-orb.compaction-outcome",
        data: { operationId: "compact", outcome, message: text },
      });
      expect(mapped.isOk()).toBe(true);
      if (mapped.isErr()) return;
      const html = renderToStaticMarkup(
        <HistoryView records={[mapped.value]} liveBlocks={[]} tools={[]} busy={false} />,
      );
      expect(html.split(text)).toHaveLength(2);
      expect(html.includes('class="msg-text error-text"')).toBe(red);
    },
  );

  it.each(["failed", "aborted"] as const)(
    "renders actual Claude %s outcome as one canonical compaction row through handoff/reload",
    async (outcome) => {
      const f = new ComposedClaudeFixture();
      try {
        await f.attach();
        const next = f.nextQuery();
        const compacting = f.agent.compact(undefined, "compact");
        const query = await next;
        const command = await query.input.next();
        if (command.done) throw new Error("missing compact command");
        f.receipt(command.value);
        const task = new NoSimulationTask("claude-outcome-render", false);
        const aborting = outcome === "aborted" ? f.agent.abortOperation() : undefined;
        if (outcome === "failed")
          await query.emit(task, {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
          } as typeof rootResult);
        else await query.emit(task, rootResult);
        query.exit();
        query.endOutput();
        await aborting;
        expect((await compacting).isErr()).toBe(true);
        const records = f.agent.snapshot()._unsafeUnwrap().records;
        const text =
          outcome === "failed" ? "Context compaction failed." : "Context compaction cancelled.";
        for (const handoff of [true, false]) {
          const html = renderToStaticMarkup(
            <HistoryView
              records={records}
              liveBlocks={[]}
              tools={[]}
              busy={handoff}
              compacting={handoff}
              {...(handoff ? { compaction: { operationId: "compact", afterId: null } } : {})}
            />,
          );
          expect(html).toContain("compaction-activity");
          expect(html).not.toContain('activity-rail-label">compacting');
          expect(html.match(/class="rec rec-orb"/g)).toHaveLength(1);
          expect(html.split(text)).toHaveLength(2);
          expect(html.includes('class="msg-text error-text"')).toBe(outcome === "failed");
        }
      } finally {
        f.dispose();
      }
    },
  );

  it("keeps mapped stream warnings neutral", () => {
    const mapped = mapPiEntry({
      id: "stream-warning",
      parentId: null,
      timestamp: "now",
      type: "custom",
      customType: "pi-orb.stream-audit",
      data: { edge: "no_event_gap" },
    });
    expect(mapped.isOk()).toBe(true);
    if (mapped.isErr()) return;
    const html = renderToStaticMarkup(
      <HistoryView records={[mapped.value]} liveBlocks={[]} tools={[]} busy={false} />,
    );
    expect(html).toContain("no decoded event for 60 seconds.");
    expect(html).not.toContain("error-text");
  });

  it("renders durable manual-compaction outcomes without exposing hidden events", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[
          {
            id: "failed",
            parentId: null,
            timestamp: "now",
            overflow: {},
            type: "event",
            eventType: "agent.compaction",
            content: [{ type: "text", text: "Compaction aborted" }],
          },
          {
            id: "hidden",
            parentId: "failed",
            timestamp: "now",
            overflow: {},
            type: "event",
            eventType: "native.hidden",
            content: [{ type: "text", text: "private event" }],
          },
        ]}
        liveBlocks={[]}
        tools={[]}
        busy={false}
      />,
    );
    expect(html).toContain("Compaction aborted");
    expect(html).not.toContain("private event");
  });

  it("renders canonical compaction with the shared activity disclosure", () => {
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
    expect(html.match(/class="record-compaction rec rec-orb"/g)).toHaveLength(1);
    expect(html).toContain("compaction-activity");
    expect(html.match(/rec rec-orb/g)).toHaveLength(2);
  });

  it("renders live streaming output, tool chips, and the bit register as an agent record", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[message("u1", "user", "go")]}
        liveBlocks={[{ blockId: "b1", blockType: "text", text: "streaming now", revision: 1 }]}
        tools={[{ callId: "call-1", name: "bash", state: "running", message: null }]}
        busy
      />,
    );

    expect(html.match(/rec rec-orb/g)).toHaveLength(1);
    expect(html.match(/class="visually-hidden">Orb:<\/span>/g)).toHaveLength(1);
    expect(html).toContain("streaming now");
    expect(html).toContain("activity-rail-row-running tool-activity-category");
    expect(html).toContain('class="activity-rail-label">commands</span>');
    expect(html).toContain('class="bit-register"');
    expect(html).not.toContain('class="cur"');
  });

  it.each(["waiting", "text", "reasoning", "tool", "merged"] as const)(
    "renders exactly one accessible bit register only while busy: %s",
    (scenario) => {
      const records = scenario === "merged" ? [message("a1", "assistant", "committed output")] : [];
      const liveBlocks =
        scenario === "waiting" || scenario === "tool"
          ? []
          : [
              {
                blockId: "live",
                blockType: scenario === "reasoning" ? scenario : ("text" as const),
                text: "retained output",
                revision: 1,
              },
            ];
      const tools =
        scenario === "tool"
          ? [{ callId: "call", name: "read", state: "running" as const, message: null }]
          : [];
      for (const busy of [true, false]) {
        const html = renderToStaticMarkup(
          <HistoryView records={records} liveBlocks={liveBlocks} tools={tools} busy={busy} />,
        );
        expect(html.match(/class="bit-register"/g) ?? []).toHaveLength(busy ? 1 : 0);
        expect(html).not.toContain('class="cur"');
        if (busy) {
          expect(html).toContain('role="status" aria-label="Agent working"');
          expect(html).toContain('class="bit-register-frames" aria-hidden="true"');
          expect(html).toContain(
            "<span>001</span><span>011</span><span>010</span><span>110</span><span>111</span><span>101</span><span>100</span><span>000</span>",
          );
        }
        if (liveBlocks.length > 0 && scenario !== "reasoning")
          expect(html).toContain("retained output");
        if (scenario === "reasoning") expect(html).not.toContain("retained output");
      }
    },
  );
});

describe("HistoryView", () => {
  it("gives each persisted assistant message one raw-Markdown copy action", () => {
    const mixed: HistoryRecord = {
      id: "mixed",
      parentId: null,
      timestamp: "time-mixed",
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "  " },
        { type: "text", text: "First **source**." },
        { type: "reasoning", text: "private reasoning" },
        { type: "tool_call", callId: "call", name: "read", arguments: { path: "secret" } },
        { type: "text", text: "Second [source](https://example.com)." },
      ],
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[mixed]} liveBlocks={[]} tools={[]} busy={false} />,
    );

    expect(assistantResponseMarkdown(mixed)).toBe(
      "First **source**.\n\nSecond [source](https://example.com).",
    );
    expect(html.match(/class="icon-button response-copy"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Copy response Markdown"');
    expect(html).toContain("response-markdown");
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("response-copy"));
    expect(html.indexOf("response-copy")).toBeLessThan(html.indexOf("Second"));
  });

  it("uses each live text block as its truthful pre-commit copy boundary", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        records={[]}
        liveBlocks={[
          {
            blockId: "text-1",
            blockType: "text",
            text: "First live block",
            revision: 1,
          },
          {
            blockId: "reasoning",
            blockType: "reasoning",
            text: "thinking",
            revision: 1,
          },
          {
            blockId: "text-2",
            blockType: "text",
            text: "Second live block",
            revision: 1,
          },
        ]}
        tools={[]}
        busy
      />,
    );

    expect(html.match(/class="icon-button response-copy"/g)).toHaveLength(2);
    expect(html.match(/class="response-markdown"/g)).toHaveLength(2);
  });

  it("omits response copy for thinking, tools, empty text, and user messages", () => {
    const emptyAssistant = message("empty", "assistant", "") as Extract<
      HistoryRecord,
      { type: "message" }
    >;
    emptyAssistant.content = [
      { type: "reasoning", text: "thinking only" },
      { type: "text", text: "   " },
    ];
    const html = renderToStaticMarkup(
      <HistoryView
        records={[message("user", "user", "user source"), emptyAssistant]}
        liveBlocks={[{ blockId: "empty-live", blockType: "text", text: "", revision: 1 }]}
        tools={[{ callId: "live-tool", name: "read", state: "running", message: null }]}
        busy
      />,
    );

    expect(assistantResponseMarkdown(emptyAssistant)).toBeNull();
    expect(html).not.toContain("response-copy");
  });

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

  it("renders image references without inline bytes or URLs, with a fetched-body fallback", () => {
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
    expect(html).toContain("Loading…");
    expect(html).not.toContain("aGVsbG8=");
    expect(html).not.toContain("https://example.com/pic.png");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "image", url: "https://example.com/pic.png" }}
          context={detailContext()}
          recordId="with-url"
          detailKey="with-url:0"
        />,
      ),
    ).toContain('src="https://example.com/pic.png"');
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "image" }}
          context={detailContext()}
          recordId="bare"
          detailKey="bare:0"
        />,
      ),
    ).toContain("[image]");
  });

  it("consolidates persisted tool calls and defers command output bodies", () => {
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
            message: "Waiting for execution.",
          },
        ]}
        busy
      />,
    );

    expect(html).toContain("activity-rail-row-completed tool-activity-category");
    expect(html).toContain('class="activity-rail-label">commands</span>');
    expect(html).toContain('<code class="trunc" title="echo tool-input">echo tool-input</code>');
    expect(html).not.toContain("1 command ran");
    expect(html).not.toContain("1 ran");
    expect(html).toContain('title="echo tool-input"');
    expect(html).not.toContain('class="tool-command-text"');
    expect(html).toContain("activity-rail-row-completed");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "tool_call", arguments: { command: "echo tool-input" } }}
          context={detailContext()}
          recordId="assistant-tool-call"
          detailKey="assistant-tool-call:0"
        />,
      ),
    ).toContain("echo tool-input");
    expect(html).not.toContain("tool-output");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "tool_result", content: [{ type: "text", text: "tool-output" }] }}
          context={detailContext()}
          recordId="result"
          detailKey="result:0"
        />,
      ),
    ).toContain("tool-output");
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
    expect(html).toContain("Waiting for execution.");
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
      patch?: string,
    ): HistoryRecord => ({
      id,
      parentId: "calls",
      timestamp: `time-${id}`,
      type: "message",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId,
          content: [{ type: "text", text }],
          isError,
          ...(patch === undefined ? {} : { patch }),
        },
      ],
      overflow: {},
    });
    const records = [
      callRecord,
      toolResult(
        "edit-result",
        "edit-1",
        "updated",
        false,
        "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra",
      ),
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
    expect(html).toContain('class="tool-call-status tool-call-failed">failed');
    expect(html).not.toContain("one test failed");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "tool_result", content: [{ type: "text", text: "one test failed" }] }}
          context={detailContext()}
          recordId="result"
          detailKey="result:0"
        />,
      ),
    ).toContain("one test failed");
  });

  it("opens unmatched image result disclosures without embedding previews", () => {
    const record: HistoryRecord = {
      id: "orphan-result",
      parentId: null,
      timestamp: "time-orphan",
      type: "message",
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "missing-call",
          content: [
            { type: "text", text: "fallback text" },
            { type: "image", url: "https://example.test/fallback.png" },
          ],
        },
      ],
      overflow: {},
    };
    const html = renderToStaticMarkup(
      <HistoryView records={[record]} liveBlocks={[]} tools={[]} busy={false} />,
    );

    expect(html).toContain("tool output · missing-call");
    expect(html).toContain('<details class="tool-details" open="">');
    expect(html).not.toContain("tool-image-previews");
    expect(html).not.toContain("fallback text");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "tool_result", content: [{ type: "image", imageRef: "result:0:0" }] }}
          context={detailContext()}
          recordId="result"
          detailKey="result:0"
        />,
      ),
    ).toContain("Loading…");
  });
});
