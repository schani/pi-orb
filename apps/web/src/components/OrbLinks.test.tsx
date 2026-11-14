import type { OrbLinksResponse } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrbLinksDrawer, Waterfall } from "./OrbLinks.tsx";

const T = Date.UTC(2026, 10, 11, 17, 0, 0);
const times = (_queued: number, started: number | null, completed: number | null) => ({
  startedAt: started === null ? null : T + started * 1000,
  completedAt: completed === null ? null : T + completed * 1000,
  id: "check",
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
        diff: { additions: 525, deletions: 38 },
        comments: null,
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

const renderWaterfall = (value: OrbLinksResponse) =>
  renderToStaticMarkup(
    <Waterfall orbId="orb" checks={value.items[0]?.github?.checks ?? []} now={T + 200_000} />,
  );

const render = (value: OrbLinksResponse | null, error = null) =>
  renderToStaticMarkup(
    <OrbLinksDrawer orbId="orb" links={value} error={error} onRemove={() => {}} />,
  );

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
    expect(html).not.toContain('class="link-timeline"');
    expect(html).toContain("--orb-link-ref:13ch");
    expect(html).toContain("--orb-link-strip:36px");
  });

  it("lays started checks out as runs on one track", () => {
    const table = renderWaterfall(links).split('<table class="link-timeline">')[1] ?? "";
    expect(table).toContain('<td class="link-timeline-duration">1m 00s</td>');
    expect(table).toContain('<td class="link-timeline-duration">2m 00s</td>');
    expect(table).toContain(
      '<td class="link-timeline-dot"><span class="activity-strip-dot activity-strip-failed"></span></td>',
    );
    expect(table).not.toContain("start");
    expect(table).not.toContain("link-timeline-queued");
    expect(table).toContain("link-timeline-bar link-timeline-passed");
    expect(table).toContain("link-timeline-bar link-timeline-failed");
    expect(table).toContain("link-timeline-bar link-timeline-running");
    expect(table).toContain('aria-expanded="false"');
    expect(table).toContain("link-timeline-unfolds");
  });

  it("draws a pending check as waiting for a runner from when it became ready until now", () => {
    const queued: OrbLinksResponse = {
      ...links,
      items: [
        {
          url: "https://github.com/schani/pi-orb/pull/291",
          addedAt: 1,
          github: {
            title: "t",
            status: "open",
            diff: null,
            comments: null,
            checks: [
              { name: "build", result: "passed", url: null, ...times(0, 5, 65) },
              { name: "e2e", result: "pending", url: null, ...times(0, 30, null) },
            ],
          },
        },
      ],
    };
    const table = renderWaterfall(queued).split('<table class="link-timeline">')[1] ?? "";
    const e2e = table.split("e2e")[1] ?? "";
    expect(e2e).toContain("link-timeline-queued");
    expect(e2e).not.toContain("link-timeline-pending");
    expect(e2e).toContain('<td class="link-timeline-duration"></td>');
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

  it("orders open before closed, then pull requests, issues and runs, each with its icon", () => {
    const item = (url: string, status: string | null) => ({
      url: `https://github.com/schani/pi-orb/${url}`,
      addedAt: 1,
      github:
        status === null ? null : { title: url, status, diff: null, comments: null, checks: [] },
    });
    const html = render({
      ...links,
      items: [
        item("actions/runs/1", "passed"),
        item("pull/2", "merged"),
        item("actions/runs/3", "running"),
        item("issues/4", "open"),
        item("issues/5", "closed"),
        item("pull/6", "draft"),
        item("pull/7", null),
      ],
    });
    const roster = html.split('class="orb-links-roster"')[1] ?? "";
    expect([...roster.matchAll(/href="[^"]*\/(\d+)"/g)].map((m) => m[1])).toEqual([
      "6",
      "7",
      "4",
      "3",
      "2",
      "5",
      "1",
    ]);
    const summary = html.split("</summary>")[0] ?? "";
    expect([...summary.matchAll(/aria-label="(\d+|#\d+)/g)].map((m) => m[1])).toEqual([
      "#6",
      "#7",
      "#4",
      "3",
      "#2",
      "#5",
      "1",
    ]);
    expect(roster).toContain('href="#i-pull"');
    expect(roster).toContain('href="#i-issue"');
    expect(roster).toContain('href="#i-run"');
    expect(roster).toContain(">3</a>");
  });

  it("colours kind icons in the activity-strip states", () => {
    const tones = Object.entries({
      "pull/1:review": "ok",
      "pull/2:draft": "muted",
      "pull/3:merged": null,
      "pull/4:closed": "muted",
      "issues/5:open": "ok",
      "issues/6:closed": null,
      "actions/runs/7:passed": null,
      "actions/runs/8:failed": "bad",
      "actions/runs/9:running": "ok",
      "actions/runs/10:queued": "muted",
    });
    const html = render({
      ...links,
      items: tones.map(([key]) => {
        const [path, status = ""] = key.split(":");
        return {
          url: `https://github.com/schani/pi-orb/${path}`,
          addedAt: 1,
          github: { title: "t", status, diff: null, comments: null, checks: [] },
        };
      }),
    });
    for (const [key, tone] of tones)
      expect(html).toMatch(
        new RegExp(
          `class="orb-link-kind${tone === null ? "" : ` orb-link-${tone}`}"><svg[^>]*><use[^>]*></use></svg></span><a href="[^"]*/${key.split(":")[0]}"`,
        ),
      );
    expect(render(links)).toMatch(
      /class="orb-link-kind"><svg[^>]*><use[^>]*><\/use><\/svg><\/span><a href="[^"]*determined\/pull\/14"/,
    );
  });

  it("shows each kind's size: PR line diff, issue comments, run duration", () => {
    const github = (fields: object) => ({
      title: "t",
      status: "open",
      diff: null,
      comments: null,
      checks: [],
      ...fields,
    });
    const html = render({
      ...links,
      items: [
        {
          url: "https://github.com/schani/pi-orb/issues/1",
          addedAt: 1,
          github: github({ comments: 4 }),
        },
        {
          url: "https://github.com/schani/pi-orb/issues/2",
          addedAt: 1,
          github: github({ comments: 1 }),
        },
        {
          url: "https://github.com/schani/pi-orb/actions/runs/3",
          addedAt: 1,
          github: github({
            status: "passed",
            checks: [
              { name: "build", result: "passed", url: null, ...times(0, 5, 65) },
              { name: "e2e", result: "passed", url: null, ...times(0, 10, 205) },
            ],
          }),
        },
        { url: "https://github.com/schani/pi-orb/actions/runs/4", addedAt: 1, github: github({}) },
        { url: "https://github.com/schani/pi-orb/issues/5", addedAt: 1, github: null },
      ],
    });
    const metrics = [
      ...html.matchAll(/<span class="orb-link-metric">(.*?)<\/span><span class="orb-link-strip">/g),
    ];
    expect(metrics.map((m) => m[1])).toEqual(["4 comments", "1 comment", "", "", "3m 20s"]);
    expect(render(links)).toContain(
      '<span class="orb-link-metric"><span class="orb-link-ok">+525</span> <span class="orb-link-bad">-38</span></span>',
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
