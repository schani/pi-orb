import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { OrbFilesBaseUrl } from "./OrbFilesBaseUrl.ts";

const FILES_BASE = "https://files.example/files/11111111-1111-4111-8111-111111111111";

function render(markdown: string, filesBaseUrl: string | undefined = FILES_BASE) {
  return renderToStaticMarkup(
    <OrbFilesBaseUrl.Provider value={filesBaseUrl}>
      <ChatMarkdown>{markdown}</ChatMarkdown>
    </OrbFilesBaseUrl.Provider>,
  );
}

describe("orb-local Markdown links", () => {
  it.each([
    ["[readme](orb:README.md)", `${FILES_BASE.replace("/files/", "/files/repo/")}/README.md`],
    ["[report](orb:/tmp/report.html)", `${FILES_BASE}/tmp/report.html`],
    [
      "[readme][file]\n\n[file]: orb:README.md",
      `${FILES_BASE.replace("/files/", "/files/repo/")}/README.md`,
    ],
    ["<orb:/tmp/report.html>", `${FILES_BASE}/tmp/report.html`],
    ["[literal percent](orb:dir/%25)", `${FILES_BASE.replace("/files/", "/files/repo/")}/dir/%25`],
    ["[readme](ORB:README.md)", `${FILES_BASE.replace("/files/", "/files/repo/")}/README.md`],
    [
      "[report](orb:reports/space%20%23%25%3F-%E9%9B%AA.html?download=1&view=2#section)",
      `${FILES_BASE.replace("/files/", "/files/repo/")}/reports/space%20%23%25%3F-%E9%9B%AA.html?download=1&amp;view=2#section`,
    ],
  ])("resolves %s into an ordinary web anchor", (markdown, href) => {
    const html = render(markdown);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain("onclick");
  });

  it.each([
    "orb:",
    "orb:/",
    "orb://host/tmp/report.html",
    "orb:///tmp/report.html",
    "orb:../secret",
    "orb:dir/../secret",
    "orb:/tmp/%2e%2e/secret",
    "orb:dir/%2E/file",
    "orb:dir%2Fsecret",
    "orb:/tmp/%5csecret",
    "orb:dir/%00",
    "orb:dir/%0a",
    "orb:dir/%7F",
    "orb:dir/%ZZ",
    "orb:dir/%C0%AF",
    "orb:dir//file",
  ])("leaves invalid %s nonclickable", (uri) => {
    expect(render(`[invalid](${uri})`)).not.toContain("href=");
  });

  it.each(["[percent](orb:dir/%)", "[percent][file]\n\n[file]: orb:dir/%", "<orb:dir/%>"])(
    "uses CommonMark's normalized literal-percent destination: %s",
    (markdown) => {
      expect(render(markdown)).toContain(
        `href="${FILES_BASE.replace("/files/", "/files/repo/")}/dir/%25"`,
      );
    },
  );

  it.each([
    undefined,
    "",
    "not a URL",
    "javascript:alert(1)",
    "data:text/plain,files",
    "https://user:password@files.example/files/11111111-1111-4111-8111-111111111111",
    `${FILES_BASE}?token=secret`,
    `${FILES_BASE}#hash`,
  ])("leaves links nonclickable without valid configuration: %s", (base) => {
    const html = renderToStaticMarkup(
      <OrbFilesBaseUrl.Provider value={base}>
        <ChatMarkdown>{"[readme](orb:README.md)"}</ChatMarkdown>
      </OrbFilesBaseUrl.Provider>,
    );
    expect(html).not.toContain("href=");
  });

  it("does not require orb context for historical HTTP URLs", () => {
    expect(
      renderToStaticMarkup(
        <ChatMarkdown>{"[old](https://files.example/files/old-orb/tmp/report.html)"}</ChatMarkdown>,
      ),
    ).toContain('href="https://files.example/files/old-orb/tmp/report.html"');
  });

  it("retains the default sanitizer for every other scheme and for images", () => {
    const html = render(
      "[web](https://example.com) [mail](mailto:me@example.com) [relative](/help) " +
        "[script](javascript:alert%281%29) [data](data:text/html,hello) [unknown](custom:hello) " +
        "![local](orb:/tmp/image.png)",
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:me@example.com"');
    expect(html).toContain('href="/help"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("custom:");
    expect(html).not.toContain(`${FILES_BASE}/tmp/image.png`);
  });

  it("leaves code and bare URIs literal", () => {
    const html = render("orb:README.md\n\n`orb:/tmp/report.html`\n\n```text\norb:README.md\n```");
    expect(html).not.toContain("<a href=");
    expect(html).toContain("<code>orb:/tmp/report.html</code>");
    expect(html).toContain("orb:README.md");
  });
});

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
