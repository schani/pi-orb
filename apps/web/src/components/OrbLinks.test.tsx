import type { OrbLinksResponse } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbLinksDrawer } from "./OrbLinks.tsx";

const T = Date.UTC(2026, 10, 11, 17, 0, 0);
const times = (queued: number, started: number | null, completed: number | null) => ({
  queuedAt: T + queued * 1000,
  startedAt: started === null ? null : T + started * 1000,
  completedAt: completed === null ? null : T + completed * 1000,
  steps: [],
});

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
          {
            name: "build",
            result: "passed",
            url: "https://github.com/o/r/actions/runs/1/job/1",
            ...times(0, 5, 65),
          },
          { name: "e2e", result: "failed", url: null, ...times(0, 10, 130) },
          { name: "dst", result: "running", url: null, ...times(0, 20, null) },
        ],
      },
    },
    { url: "https://github.com/schani/determined/pull/14", addedAt: 2, github: null },
  ],
};

const render = (value: OrbLinksResponse | null, error = null) =>
  renderToStaticMarkup(<OrbLinksDrawer links={value} error={error} onRemove={() => {}} />);

describe("OrbLinksDrawer", () => {
  it("renders refs, titles, check dots, status and a bin per link", () => {
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
    expect(html.match(/aria-label="Remove link"/g)).toHaveLength(2);
    expect(html).toContain('href="https://github.com/o/r/actions/runs/1/job/1"');
    expect(html).toContain("<span>e2e</span>");
    expect(html).toContain("--orb-link-ref:13ch");
    expect(html).toContain("--orb-link-strip:36px");
  });

  it("lays checks out as a waterfall of queued time, then the run", () => {
    const table = render(links).split('<table class="link-timeline">')[1] ?? "";
    expect(table).toContain(" 1m 00s</span>");
    expect(table).toContain(" 2m 00s</span>");
    expect(table.match(/link-timeline-queued/g)).toHaveLength(3);
    expect(table).toContain("link-timeline-bar link-timeline-passed");
    expect(table).toContain("link-timeline-bar link-timeline-failed");
    expect(table).toContain("link-timeline-bar link-timeline-running");
    expect(table).not.toContain("link-timeline-unfolds");
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
