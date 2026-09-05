import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { markdownCodeText } from "./MarkdownCodeBlock.tsx";

describe("Markdown code block copy", () => {
  it("renders boxed code and a copy action without a language header", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"Use `inline` here.\n\n```ts\nconst answer = 42;\n```"}</ChatMarkdown>,
    );

    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('class="icon-button markdown-code-copy" data-state="idle"');
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html.match(/markdown-code-copy/g)).toHaveLength(1);
    expect(html).not.toContain("markdown-code-head");
    expect(html).not.toContain("<span>ts</span>");
    expect(html).toContain('class="language-ts"');
  });

  it.each(["", "text", "txt", "plaintext", "plain", "TEXT", "ts", "python", "json"])(
    "renders %s raw text in a box without a header",
    (language) => {
      const html = renderToStaticMarkup(
        <ChatMarkdown>{`\`\`\`${language}\n  quoted raw text\nsecond line\n\`\`\``}</ChatMarkdown>,
      );
      expect(html).toContain('class="markdown-code-block"');
      expect(html).not.toContain("markdown-code-head");
      expect(html).toContain("  quoted raw text\nsecond line\n</code></pre>");
      expect(html.match(/markdown-code-copy/g)).toHaveLength(1);
    },
  );

  it("copies source text without react-markdown's fence-closing newline", () => {
    expect(markdownCodeText(<code>{"  indented\nsecond  \n"}</code>)).toBe("  indented\nsecond  ");
  });
});
