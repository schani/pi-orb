import type { TurnTimeline } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { clock } from "../lib/turn-timeline.ts";
import { TimelineFailure, TimelineTable } from "./TurnTimeline.tsx";

const T = Date.UTC(2026, 9, 24, 12);

const timeline: TurnTimeline = {
  start: T,
  rows: [
    {
      kind: "model",
      id: "a1",
      start: T,
      end: T + 4_000,
      use: "root",
      model: "gpt-6-astra",
      ttftMs: 1_000,
      thinkingMs: 2_000,
      output: 10,
      stop: "toolUse",
      said: "Reading the config.",
    },
    {
      kind: "tool",
      id: "c1",
      start: T + 4_000,
      end: T + 8_000,
      name: "codemode",
      nested: false,
      status: "error",
      result: "Error: boom",
      calls: 1,
    },
    {
      kind: "tool",
      id: "c1:1",
      start: T + 5_000,
      end: T + 6_000,
      name: "read",
      nested: true,
      status: "ok",
    },
    {
      kind: "model",
      id: "k1",
      start: T + 8_000,
      end: T + 9_000,
      use: "compaction",
      model: "gpt-6-astra",
    },
    {
      kind: "model",
      id: "call:2",
      start: T + 9_000,
      end: T + 10_000,
      use: "turn_summary",
      model: "gpt-6-luna",
    },
    { kind: "marker", id: "alert", start: T + 10_000, marker: "alert", text: "Disk full" },
  ],
};

describe("turn timeline table", () => {
  it("renders start, call and a bar per row on the turn's time scale", () => {
    const html = renderToStaticMarkup(
      <TimelineTable timeline={timeline} open={null} onToggle={() => {}} onHover={() => {}} />,
    );
    expect(html).toContain("<th>start</th><th>call</th>");
    expect(html.match(/<tr class="timeline-row/g)).toHaveLength(6);
    expect(html).toContain(`>${clock(T + 5_000)}<`);
    expect(html).toContain('<span class="timeline-arg">Reading the config.</span>');
    expect(html).toContain(
      '<div class="timeline-bar timeline-llm" style="left:0%;width:40%"><span class="timeline-wait" style="left:0%;width:25%"></span><span class="timeline-think" style="left:25%;width:25%"></span><span class="timeline-stream" style="left:50%;width:50%"></span></div>',
    );
    expect(html).toContain(
      'class="timeline-bar timeline-tool timeline-failed" style="left:40%;width:40%"',
    );
    expect(html).toContain('class="timeline-indent"');
    expect(html).toContain(
      'class="timeline-bar timeline-tool timeline-nested" style="left:50%;width:10%"',
    );
    expect(html).toContain('class="timeline-bar timeline-compaction"');
    expect(html).toContain('<tr class="timeline-row timeline-side"');
    expect(html).toContain('class="timeline-bar timeline-aux"');
    expect(html).toContain('<tr class="timeline-row timeline-alert"');
    expect(html).toContain(
      'class="timeline-bar timeline-instant timeline-failed" style="left:100%"',
    );
    expect(html).not.toContain("timeline-detail");
  });

  it("expands one row into its facts, without repeating the call cell", () => {
    const html = renderToStaticMarkup(
      <TimelineTable timeline={timeline} open="c1" onToggle={() => {}} onHover={() => {}} />,
    );
    expect(html).toContain('<tr class="timeline-row timeline-open"');
    expect(html).toContain(
      '<tr class="timeline-detail"><td colSpan="3"><dl class="timeline-facts"><dt>duration</dt><dd>4.0s</dd><dt>result</dt><dd class="error-text">Error: boom</dd><dt>calls</dt><dd>1</dd></dl></td></tr>',
    );
  });
});

describe("turn timeline failures", () => {
  it("says a missing turn does not exist and offers a retry for anything else", () => {
    expect(renderToStaticMarkup(<TimelineFailure missing onRetry={() => {}} />)).toBe(
      '<p class="timeline-failure">This turn doesn’t exist.</p>',
    );
    expect(renderToStaticMarkup(<TimelineFailure missing={false} onRetry={() => {}} />)).toBe(
      '<p class="timeline-failure error-text" role="alert">Timeline unavailable. <button type="button">Retry</button></p>',
    );
  });
});
