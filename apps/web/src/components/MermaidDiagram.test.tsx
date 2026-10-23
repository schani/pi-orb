import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.tsx";

const FLOW = "flowchart LR\n  A --> B";

describe("Mermaid fences", () => {
  it("renders a closed fence as a diagram board with source, open and copy tools", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`Path:\n\n\`\`\`mermaid\n${FLOW}\n\`\`\``}</ChatMarkdown>,
    );
    expect(html).toContain('class="mermaid-diagram"');
    expect(html).toContain('aria-label="Show Mermaid source"');
    expect(html).toContain('aria-label="Open diagram"');
    expect(html).toContain('aria-label="Copy code to clipboard"');
    expect(html).not.toContain("markdown-code-block");
  });

  it("keeps a streaming fence without its closing fence as a code block", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`Path:\n\n\`\`\`mermaid\n${FLOW}`}</ChatMarkdown>,
    );
    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('class="language-mermaid"');
    expect(html).not.toContain("mermaid-diagram");
  });

  it.each([
    ["a blockquote", `> \`\`\`mermaid\n> ${FLOW.replace("\n", "\n> ")}\n> \`\`\``],
    ["a list item", `- item\n\n  ~~~mermaid\n  ${FLOW.replace("\n", "\n  ")}\n  ~~~`],
  ])("renders a closed fence inside %s", (_, markdown) => {
    expect(renderToStaticMarkup(<ChatMarkdown>{markdown}</ChatMarkdown>)).toContain(
      'class="mermaid-diagram"',
    );
  });
});
