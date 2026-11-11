import type { OrbLinksResponse } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbLinksDrawer } from "./OrbLinks.tsx";

const links: OrbLinksResponse = {
  repository: "schani/pi-orb",
  githubError: null,
  items: [
    {
      url: "https://github.com/schani/pi-orb/pull/291",
      addedAt: 1,
      github: {
        title: "Add links drawer",
        status: "draft",
        checks: [
          { name: "build", result: "passed" },
          { name: "e2e", result: "failed" },
          { name: "dst", result: "running" },
        ],
      },
    },
    { url: "https://github.com/schani/determined/pull/14", addedAt: 2, github: null },
  ],
};

const render = (value: OrbLinksResponse | null, error = null) =>
  renderToStaticMarkup(<OrbLinksDrawer links={value} error={error} onRemove={() => {}} />);

describe("OrbLinksDrawer", () => {
  it("renders refs, titles, check dots, status and remove per link", () => {
    const html = render(links);
    expect(html).toContain('class="orb-links activity-rail-row"');
    expect(html).toContain('href="https://github.com/schani/pi-orb/pull/291"');
    expect(html).toContain(">#291</a>");
    expect(html).toContain(">determined#14</a>");
    expect(html).toContain("Add links drawer");
    expect(html).toContain("draft");
    expect(html).toContain(
      'class="activity-strip-dot activity-strip-failed" role="img" aria-label="e2e · failed"',
    );
    expect(html).toContain(
      'class="activity-strip-dot activity-strip-running" role="img" aria-label="dst · running"',
    );
    expect(html).toContain('class="activity-strip-dot" role="img" aria-label="build · passed"');
    expect(html.match(/>remove</g)).toHaveLength(2);
    expect(html).toContain("--orb-link-ref:13ch");
    expect(html).toContain("--orb-link-strip:36px");
  });

  it("summarizes each link by its worst check", () => {
    const summary = render(links).split("</summary>")[0] ?? "";
    expect(summary).toContain(
      'class="activity-strip-dot activity-strip-failed" role="img" aria-label="#291 · draft"',
    );
    expect(summary).toContain(
      'class="activity-strip-dot orb-link-pending" role="img" aria-label="determined#14"',
    );
  });

  it("hides without links and shows GitHub failures", () => {
    expect(render(null)).toBe("");
    expect(render({ ...links, items: [] })).toBe("");
    expect(render({ ...links, githubError: "GitHub login required" })).toContain(
      "GitHub login required",
    );
  });
});
