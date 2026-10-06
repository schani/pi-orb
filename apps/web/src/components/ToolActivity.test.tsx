import type { ContentBlock, HistoryRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { detailContext, displayRecord } from "../testkit/display-fixtures.ts";
import { DetailContent } from "./DetailBody.tsx";
import { ToolActivity as BrowserToolActivity, type LiveToolCall } from "./ToolActivity.tsx";

type RawPair = {
  call: Extract<ContentBlock, { type: "tool_call" }>;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
};
function ToolActivity({
  persisted = [],
  live = [],
}: {
  persisted?: readonly RawPair[];
  live?: readonly LiveToolCall[];
}) {
  const projected = persisted.map(({ call, result }, index) => {
    const callRecordId = `call-${index}`;
    const callRecord = displayRecord({
      id: callRecordId,
      parentId: null,
      timestamp: "now",
      type: "message",
      role: "assistant",
      content: [call],
      overflow: {},
    });
    if (callRecord.type !== "message") throw new Error("expected message projection");
    const displayCall = callRecord.content[0];
    if (displayCall?.type !== "tool_call") throw new Error("expected call projection");
    if (result === undefined) return { call: displayCall, callRecordId };
    const resultRecordId = `result-${index}`;
    const resultRecord = displayRecord({
      id: resultRecordId,
      parentId: callRecordId,
      timestamp: "now",
      type: "message",
      role: "tool",
      content: [result],
      overflow: {},
    } satisfies HistoryRecord);
    if (resultRecord.type !== "message") throw new Error("expected message projection");
    const displayResult = resultRecord.content[0];
    if (displayResult?.type !== "tool_result") throw new Error("expected result projection");
    return { call: displayCall, callRecordId, result: displayResult, resultRecordId };
  });
  return <BrowserToolActivity persisted={projected} live={live} detailContext={detailContext()} />;
}

describe("code header fallback", () => {
  it.each(["bash", "codemode"])(
    "%s shows live code without details or a summary request",
    (name) => {
      const html = renderToStaticMarkup(
        <BrowserToolActivity
          detailContext={detailContext()}
          live={[{ callId: "live", name, state: "running", code: "raw source" }]}
        />,
      );
      expect(html).toContain('<code class="trunc" title="raw source">raw source</code>');
      expect(html).not.toContain("Loading…");
    },
  );
  it.each(["bash", "codemode"])("%s uses call code until the selected summary is ready", (name) => {
    const code = '\nprint("<b>  literal</b>")\nnext()';
    const render = (intent: string | null | undefined, outcome?: string | null) =>
      renderToStaticMarkup(
        <BrowserToolActivity
          detailContext={detailContext()}
          persisted={[
            {
              callRecordId: "intent",
              call: {
                type: "tool_call",
                callId: "one",
                name,
                detailKey: "intent:0",
                code,
                ...(intent === undefined ? {} : { headline: intent }),
              },
              ...(outcome === undefined
                ? {}
                : {
                    resultRecordId: "outcome",
                    result: {
                      type: "tool_result",
                      callId: "one",
                      detailKey: "outcome:0",
                      headline: outcome,
                      hasImages: false,
                    },
                  }),
            },
          ]}
        />,
      );
    for (const html of [render(undefined), render(null), render("Intent ready", null)]) {
      expect(html).toContain('<code class="trunc"');
      expect(html).toContain("print(&quot;&lt;b&gt;  literal&lt;/b&gt;&quot;)");
      expect(html).not.toContain("Intent ready");
      expect(html).not.toContain("Loading…");
    }
    for (const html of [render("Ready"), render(null, "Ready")]) {
      expect(html).toContain("Ready");
      expect(html).not.toContain("literal");
    }
    for (const html of [render(""), render("Intent ready", "")]) {
      expect(html).not.toContain("literal");
      expect(html).not.toContain("Intent ready");
    }
  });

  it("keeps grouped command count and individual code headers", () => {
    const html = renderToStaticMarkup(
      <BrowserToolActivity
        detailContext={detailContext()}
        persisted={["pwd", "ls", "date"].map((code, index) => ({
          callRecordId: `call-${index}`,
          call: {
            type: "tool_call",
            callId: `${index}`,
            name: "bash",
            detailKey: `call-${index}:0`,
            headline: null,
            code,
          },
        }))}
      />,
    );
    expect(html).toContain("3 ran");
    for (const code of ["pwd", "ls", "date"]) expect(html).toContain(`>${code}</code>`);
    expect(html).not.toContain("Loading…");
  });
});

describe("bounded call labels", () => {
  it("uses the tool name for an empty generic projection heading and tooltip", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "generic-1",
              name: "browser_snapshot",
              arguments: {},
            },
          },
          {
            call: {
              type: "tool_call",
              callId: "generic-other",
              name: "browser_snapshot",
              arguments: {},
            },
          },
        ]}
      />,
    );
    expect(html).toContain('<code class="trunc" title="browser_snapshot">browser_snapshot</code>');
    const longName = "界".repeat(400);
    const capped = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: { type: "tool_call", callId: "generic-2", name: longName, arguments: {} },
          },
          {
            call: { type: "tool_call", callId: "generic-3", name: longName, arguments: {} },
          },
        ]}
      />,
    );
    const label = capped.match(/<code class="trunc" title="([^"]+)">([^<]+)<\/code>/);
    expect(label?.[1]).toBe(label?.[2]);
    expect(Buffer.byteLength(label?.[1] ?? "")).toBeLessThanOrEqual(1024);
  });
  it("caps a multibyte read path with its range once for text and tooltip", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "read-1",
              name: "read",
              arguments: { path: "界".repeat(400), offset: 12, limit: 5 },
            },
          },
        ]}
      />,
    );
    const match = html.match(
      /<span class="activity-rail-headline" title="([^"]+)">([^<]+)<\/span>/,
    );
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(match?.[2]);
    expect(match?.[1]).toMatch(/…:12–16$/);
    expect(Buffer.byteLength(match?.[1] ?? "")).toBeLessThanOrEqual(1024);
  });
});

describe("single-call categories", () => {
  it.each(["read", "write", "edit", "bash", "subagent", "codemode", "mcp__fixture__echo"])(
    "%s uses only the category disclosure for committed and live calls",
    (name) => {
      const call: RawPair["call"] = {
        type: "tool_call",
        callId: "one",
        name,
        arguments: { path: "a.ts", command: "pwd" },
      };
      const persisted: RawPair[] = [
        {
          call,
          result: {
            type: "tool_result",
            callId: "one",
            content: [{ type: "text", text: "private output" }],
          },
        },
      ];
      for (const element of [
        <ToolActivity key="committed" persisted={persisted} />,
        <BrowserToolActivity
          key="live"
          live={[{ callId: "one", name, state: "running" }]}
          detailContext={detailContext()}
        />,
      ]) {
        const html = renderToStaticMarkup(element);
        expect(html.match(/<details\b/g)).toHaveLength(1);
        expect(html).not.toContain('class="tool-activity-call"');
        expect(html).not.toContain("private output");
        expect(html).not.toContain("Loading…");
        expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
      }
      const grouped = renderToStaticMarkup(
        <ToolActivity persisted={[...persisted, { call: { ...call, callId: "two" } }]} />,
      );
      expect(grouped.match(/<details\b/g)).toHaveLength(3);
    },
  );
});

describe("live tool progress", () => {
  it("shows waiting in a single live MCP row without another disclosure", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        live={[
          {
            callId: "mcp",
            name: "mcp__fixture__echo",
            state: "running",
            message: "Waiting for execution.",
          },
        ]}
      />,
    );
    expect(html).toContain("Waiting for execution.");
    expect(html.match(/<details\b/g)).toHaveLength(1);
  });

  it("bounds generic progress in the header and does not expose the full output", () => {
    const message = `Downloading\n${"x".repeat(10000)}END_OF_OUTPUT`;
    const html = renderToStaticMarkup(
      <ToolActivity live={[{ callId: "progress", name: "bash", state: "running", message }]} />,
    );
    const metric = html.match(/tool-activity-running">([^<]*)</)?.[1];
    expect(metric).toContain("Downloading ");
    expect(metric?.length).toBeLessThanOrEqual(161);
    expect(metric).toContain("…");
    expect(html).not.toContain("END_OF_OUTPUT");
  });
});

describe("edit diff stats", () => {
  it("counts added and removed lines from the tool result patch", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "edit-1",
              name: "edit",
              arguments: { path: "src/a.ts" },
            },
            result: {
              type: "tool_result",
              callId: "edit-1",
              content: [{ type: "text", text: "updated" }],
              patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra",
            },
          },
        ]}
      />,
    );
    expect(html).toContain("+2");
    expect(html).toContain("−1");
  });
});

describe("tool image previews", () => {
  it("keeps image calls in order without embedding image bodies", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "read-one",
              name: "read",
              arguments: { path: "first.png" },
            },
            result: {
              type: "tool_result",
              callId: "read-one",
              content: [
                { type: "text", text: "first text" },
                { type: "image", mediaType: "image/png", data: "Zmlyc3Q=" },
                { type: "image", url: "https://example.test/second.png" },
              ],
            },
          },
          {
            call: {
              type: "tool_call",
              callId: "browser-one",
              name: "browser",
              arguments: { action: "screenshot" },
            },
            result: {
              type: "tool_result",
              callId: "browser-one",
              content: [{ type: "image", url: "https://example.test/third.png" }],
            },
          },
        ]}
      />,
    );

    expect(html.match(/tool-image-activity/g)).toHaveLength(2);
    expect(html.match(/<details[^>]*tool-image-activity[^>]*open=""/g)).toHaveLength(2);
    expect(html).not.toContain("tool-image-thumbnail");
    expect(html).not.toContain("tool-image-previews");
    expect(html.indexOf("first.png")).toBeLessThan(html.indexOf("browser"));
    expect(html).not.toContain("https://example.test/second.png");
    expect(html).not.toContain("https://example.test/third.png");
    expect(html).not.toContain("first text");
    const body = renderToStaticMarkup(
      <DetailContent
        body={{
          type: "tool_result",
          content: [
            { type: "text", text: "first text" },
            { type: "image", imageRef: "result-0:0:1" },
          ],
        }}
        context={detailContext()}
        recordId="result-0"
        detailKey="result-0:0"
      />,
    );
    expect(body).toContain("first text");
    expect(body).toContain("Loading…");
    expect(body).not.toContain("/images/");
    const sparse = renderToStaticMarkup(
      <DetailContent
        body={{
          type: "tool_result",
          content: [
            { type: "text", text: "visible" },
            { type: "image", imageRef: "result-0:0:4" },
          ],
        }}
        context={detailContext()}
        recordId="result-0"
        detailKey="result-0:0"
      />,
    );
    expect(sparse).toContain("Loading…");
    expect(sparse).not.toContain("/images/");
    expect(html).not.toContain('class="tool-activity-call"');
    expect(html).not.toContain("image/png Zmlyc3Q=");
  });

  it("assigns stable unique keys to same-category segments around an image call", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = renderToStaticMarkup(
        <ToolActivity
          persisted={[
            {
              call: {
                type: "tool_call",
                callId: "read-before",
                name: "read",
                arguments: { path: "before.txt" },
              },
              result: {
                type: "tool_result",
                callId: "read-before",
                content: [{ type: "text", text: "before" }],
              },
            },
            {
              call: {
                type: "tool_call",
                callId: "read-image",
                name: "read",
                arguments: { path: "middle.png" },
              },
              result: {
                type: "tool_result",
                callId: "read-image",
                content: [{ type: "image", url: "https://example.test/middle.png" }],
              },
            },
            {
              call: {
                type: "tool_call",
                callId: "read-after",
                name: "read",
                arguments: { path: "after.txt" },
              },
              result: {
                type: "tool_result",
                callId: "read-after",
                content: [{ type: "text", text: "after" }],
              },
            },
          ]}
        />,
      );

      expect(consoleError).not.toHaveBeenCalled();
      expect(html.match(/<details class="activity-rail-row/g)).toHaveLength(3);
      expect(html.indexOf('title="before.txt"')).toBeLessThan(html.indexOf('title="middle.png"'));
      expect(html.indexOf('title="middle.png"')).toBeLessThan(html.indexOf('title="after.txt"'));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("defers missing image data without exposing an empty image", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "missing",
              name: "mcp__fixture__echo",
              arguments: {},
            },
            result: {
              type: "tool_result",
              callId: "missing",
              content: [{ type: "image" }],
            },
          },
        ]}
      />,
    );
    expect(html).not.toContain("tool-image-thumbnail");
    expect(html).not.toContain("image unavailable");
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{ type: "image" }}
          context={detailContext()}
          recordId="result"
          detailKey="result:0"
        />,
      ),
    ).toContain("[image]");
  });

  it("leaves text-only compact category grouping unchanged", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={["a.png", "b.png"].map((path, index) => ({
          call: {
            type: "tool_call" as const,
            callId: `read-${index}`,
            name: "read",
            arguments: { path },
          },
          result: {
            type: "tool_result" as const,
            callId: `read-${index}`,
            content: [{ type: "text" as const, text: path }],
          },
        }))}
      />,
    );
    expect(html.match(/<details class="activity-rail-row/g)).toHaveLength(1);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
    expect(html).toContain("2 files");
    expect(html).not.toContain("tool-image-previews");
  });
});

describe("codemode nested calls", () => {
  it("shows native child status, bounded arguments and error within the parent disclosure without inventing output", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "parent",
              name: "codemode",
              arguments: { code: "run()" },
            },
            result: {
              type: "tool_result",
              callId: "parent",
              content: [{ type: "text", text: "Script failed" }],
              isError: true,
              nestedCalls: {
                complete: false,
                calls: [
                  {
                    id: "parent/1",
                    name: "mcp__fixture__echo",
                    status: "error",
                    arguments: { value: "marker" },
                    durationMs: 11,
                    error: "MCP request aborted",
                  },
                  {
                    id: "parent/2",
                    name: "read",
                    status: "unfinished",
                    argumentsBytes: 9000,
                  },
                ],
              },
            },
          },
        ]}
      />,
    );
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html).not.toContain("MCP request aborted");
    const detail = renderToStaticMarkup(
      <DetailContent
        body={{
          type: "tool_result",
          content: [{ type: "text", text: "Script failed" }],
          nestedCalls: {
            complete: false,
            calls: [
              {
                id: "parent/1",
                name: "mcp__fixture__echo",
                status: "error",
                arguments: { value: "marker" },
                durationMs: 11,
                error: "MCP request aborted",
              },
              { id: "parent/2", name: "read", status: "unfinished", argumentsBytes: 9000 },
            ],
          },
        }}
        context={detailContext()}
        recordId="result-0"
        detailKey="result-0:0"
      />,
    );
    for (const value of [
      "mcp__fixture__echo",
      "MCP request aborted",
      "11 ms",
      "arguments omitted (9000 bytes)",
      "unfinished",
      "incomplete",
    ])
      expect(detail).toContain(value);
    expect(detail).not.toContain("child output");
  });
});

describe("generic nested tool summary", () => {
  it("shows a non-codemode parent's supplied nested calls", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: { type: "tool_call", callId: "parent", name: "delegate", arguments: {} },
            result: {
              type: "tool_result",
              callId: "parent",
              content: [],
              nestedCalls: {
                complete: true,
                calls: [{ id: "parent/1", name: "read", status: "ok", durationMs: 4 }],
              },
            },
          },
        ]}
      />,
    );
    expect(html).not.toContain("read · ok · 4 ms");
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(
      renderToStaticMarkup(
        <DetailContent
          body={{
            type: "tool_result",
            content: [],
            nestedCalls: {
              complete: true,
              calls: [{ id: "parent/1", name: "read", status: "ok", durationMs: 4 }],
            },
          }}
          context={detailContext()}
          recordId="result-0"
          detailKey="result-0:0"
        />,
      ),
    ).toContain("read · ok · 4 ms");
  });
});

describe("generic tool disclosure", () => {
  it.each(["subagent", "get_subagent_result", "mcp__fixture__echo", "codemode"])(
    "defers %s input and output to detail rendering",
    (name) => {
      const html = renderToStaticMarkup(
        <ToolActivity
          persisted={[
            {
              call: {
                type: "tool_call",
                callId: "call-one",
                name,
                arguments: { task: "Inspect services" },
              },
              result: {
                type: "tool_result",
                callId: "call-one",
                content: [{ type: "text", text: "Four services found" }],
              },
            },
          ]}
        />,
      );
      expect(html.match(/<details\b/g)).toHaveLength(1);
      expect(html).not.toContain("Inspect services");
      expect(html).not.toContain("Four services found");
      expect(
        renderToStaticMarkup(
          <DetailContent
            body={{ type: "tool_call", arguments: { task: "Inspect services" } }}
            context={detailContext()}
            recordId="call-0"
            detailKey="call-0:0"
          />,
        ),
      ).toContain("Inspect services");
      expect(
        renderToStaticMarkup(
          <DetailContent
            body={{ type: "tool_result", content: [{ type: "text", text: "Four services found" }] }}
            context={detailContext()}
            recordId="result-0"
            detailKey="result-0:0"
          />,
        ),
      ).toContain("Four services found");
    },
  );
});
