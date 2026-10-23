import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { detailContext } from "../testkit/display-fixtures.ts";
import { imageIndex } from "./CommittedImage.tsx";
import { DetailContent } from "./DetailBody.tsx";

it("renders reasoning with shared Markdown semantics, preserving headings in the body", () => {
  const html = renderToStaticMarkup(
    <DetailContent
      context={detailContext()}
      recordId="r"
      detailKey="r:0"
      body={{
        type: "reasoning",
        text: "# Plan\n\n**Inspect files**\n\n- Read `file.ts`\n\n[Docs](https://example.com)\n\n```ts\nconst x = 1;\n```",
      }}
    />,
  );
  expect(html).toContain('class="chat-markdown"');
  expect(html).toContain("<h1>Plan</h1>");
  expect(html).toContain("<strong>Inspect files</strong>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<code>file.ts</code>");
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain('class="language-ts"');
});

it("keeps remote URLs browser-managed and local images loading on initial SSR", () => {
  const external = renderToStaticMarkup(
    <DetailContent
      context={detailContext()}
      recordId="r"
      detailKey="r:0"
      body={{ type: "image", url: "https://example.com/image.png" }}
    />,
  );
  expect(external).toContain('src="https://example.com/image.png"');
  const internal = renderToStaticMarkup(
    <DetailContent
      context={detailContext()}
      recordId="r"
      detailKey="r:0"
      body={{ type: "image", imageRef: "r:0:0" }}
    />,
  );
  expect(internal).toContain("Loading…");
  expect(internal).not.toContain("images/r/");
  expect(imageIndex("r:0", "r:0:4")).toBe(4);
  expect(imageIndex("r:0", "r:0:9007199254740992")).toBeNull();
});

it("preserves URL-backed tool image preview and omits base64", () => {
  const html = renderToStaticMarkup(
    <DetailContent
      context={detailContext()}
      recordId="r"
      detailKey="r:1"
      body={{
        type: "tool_result",
        content: [{ type: "image", url: "https://example.com/preview.png" }],
      }}
    />,
  );
  expect(html).toContain('src="https://example.com/preview.png"');
  expect(html).toContain("Enlarge image returned by tool result");
});

it("renders generic tool arguments and text results, and a bare-image fallback", () => {
  const render = (body: Parameters<typeof DetailContent>[0]["body"]) =>
    renderToStaticMarkup(
      <DetailContent context={detailContext()} recordId="r" detailKey="r:0" body={body} />,
    );
  expect(render({ type: "tool_call", arguments: { task: "Inspect services" } })).toContain(
    "Inspect services",
  );
  expect(
    render({ type: "tool_result", content: [{ type: "text", text: "Four services found" }] }),
  ).toContain("Four services found");
  expect(render({ type: "image" })).toContain("[image]");
});
