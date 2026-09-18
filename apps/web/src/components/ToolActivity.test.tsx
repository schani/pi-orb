import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToolActivity } from "./ToolActivity.tsx";

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
  it("keeps image calls in call order with one visible provenance header per call", () => {
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
    expect(html.match(/class="tool-image-thumbnail"/g)).toHaveLength(3);
    expect(html.match(/class="tool-image-previews"/g)).toHaveLength(2);
    expect(html.indexOf("first.png")).toBeLessThan(html.indexOf("browser"));
    expect(html.indexOf("https://example.test/second.png")).toBeLessThan(
      html.indexOf("https://example.test/third.png"),
    );
    expect(html).toContain('aria-label="Enlarge image returned by read"');
    expect(html).toContain('aria-label="Close image preview"');
    expect(html.match(/first text/g)).toHaveLength(1);
    expect(html).toContain('class="tool-image-previews"><div class="tool-image-preview">');
    expect(html).not.toContain('<details class="tool-activity-call');
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

  it("shows missing image data inline without exposing an empty image", () => {
    const html = renderToStaticMarkup(
      <ToolActivity
        persisted={[
          {
            call: {
              type: "tool_call",
              callId: "missing",
              name: "mcp_call",
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
    expect(html).toContain('class="tool-image-state" role="status">image unavailable');
    expect(html).not.toContain("tool-image-thumbnail");
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

describe("generic tool disclosure", () => {
  it.each(["subagent", "get_subagent_result", "mcp_call"])(
    "shows %s input and output behind just the category disclosure",
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
      expect(html).toContain("Inspect services");
      expect(html).toContain("Four services found");
    },
  );
});
