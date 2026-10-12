import type { ResourceWarning } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbResourceWarnings } from "./OrbResourceWarnings.tsx";

describe("repository skipped-skill notice", () => {
  it("renders nothing for absent or empty warnings", () => {
    expect(renderToStaticMarkup(<OrbResourceWarnings />)).toBe("");
    expect(renderToStaticMarkup(<OrbResourceWarnings warnings={[]} />)).toBe("");
  });
  it.each([
    ["invalid_utf8", "invalid UTF-8"],
    ["invalid_yaml", "invalid YAML"],
    ["invalid_metadata", "invalid skill metadata"],
    ["duplicate_name", "duplicate skill name"],
  ] as const)("shows the filename and understandable %s reason once", (code, reason) => {
    const html = renderToStaticMarkup(
      <OrbResourceWarnings warnings={[{ path: ".agents/skills/example/SKILL.md", code }]} />,
    );
    expect(html).toContain('class="rec rec-sys orb-notice"');
    expect(html).toContain('class="rec-bd notice"');
    expect(html).toContain("Skipped repository skill");
    expect(html.match(/\.agents\/skills\/example\/SKILL.md/g)).toHaveLength(1);
    expect(html).toContain(reason);
    expect(html).not.toContain("rec-px");
  });
  it("escapes paths as text rather than rendering HTML or Markdown", () => {
    const warnings: ResourceWarning[] = [
      { path: '<img src=x onerror="alert(1)">/SKILL.md', code: "invalid_yaml" },
      { path: "[secret](https://example.com)/SKILL.md", code: "invalid_metadata" },
    ];
    const html = renderToStaticMarkup(<OrbResourceWarnings warnings={warnings} />);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;/SKILL.md");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("[secret](https://example.com)/SKILL.md");
  });
});
