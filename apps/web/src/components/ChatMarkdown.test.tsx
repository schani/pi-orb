import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.tsx";

describe("Markdown tables", () => {
  it("wraps semantic tables in a keyboard-accessible scroll region and preserves alignment", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`| Service | Auth needed |
| --- | ---: |
| Datadog | Use **OAuth** or \`DATADOG_API_KEY\`. |
| Cloudflare | Wrangler + API |`}</ChatMarkdown>,
    );
    expect(html).toContain('class="markdown-table-scroll" aria-label="Table" tabindex="0"');
    expect(html).toContain("<table><thead>");
    expect(html).toContain('<th style="text-align:right">Auth needed</th>');
    expect(html).toContain("<td>Datadog</td>");
    expect(html).toContain("<strong>OAuth</strong>");
    expect(html).toContain("<code>DATADOG_API_KEY</code>");
  });

  it("does not wrap ordinary prose in a table region", () => {
    expect(renderToStaticMarkup(<ChatMarkdown>Just prose.</ChatMarkdown>)).not.toContain(
      "markdown-table-scroll",
    );
  });
});
