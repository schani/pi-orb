import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { markdownCodeText } from "./MarkdownCodeBlock.tsx";

describe("Markdown code block copy", () => {
  it("renders the quiet top-right copy action only for fenced code blocks", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"Use `inline` here.\n\n```ts\nconst answer = 42;\n```"}</ChatMarkdown>,
    );

    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('class="markdown-code-copy"');
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html.match(/markdown-code-copy/g)).toHaveLength(1);
    expect(html).toContain('class="language-ts"');
  });

  it("copies source text without react-markdown's fence-closing newline", () => {
    expect(markdownCodeText(<code>{"  indented\nsecond  \n"}</code>)).toBe("  indented\nsecond  ");
  });
});
