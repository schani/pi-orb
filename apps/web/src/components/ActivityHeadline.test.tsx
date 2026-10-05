import type { DisplayRecord } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { detailContext } from "../testkit/display-fixtures.ts";
import { SubagentNotice } from "./SubagentNotice.tsx";
import { ToolActivity, type ToolCallBlock, type ToolResultBlock } from "./ToolActivity.tsx";

function markup(headline: string | null | undefined, result?: ToolResultBlock) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: "one",
    name: "invented_fixture_tool",
    detailKey: "intent:0",
    ...(headline !== undefined ? { headline } : {}),
  };
  return renderToStaticMarkup(
    <ToolActivity
      detailContext={detailContext()}
      persisted={[
        {
          call,
          callRecordId: "intent",
          ...(result ? { result, resultRecordId: "outcome" } : {}),
        },
      ]}
    />,
  );
}

describe("activity headline rendering", () => {
  it("renders supplied arbitrary-tool text without another disclosure, but not unsupported headings", () => {
    expect(markup("Canonical text")).toContain('title="Canonical text">Canonical text</span>');
    expect(markup("")).toContain('class="activity-rail-headline" title=""></span>');
    for (const headline of [null, undefined]) {
      expect(markup(headline)).not.toContain('class="activity-rail-headline"');
    }
    expect(markup("Canonical text").match(/<details/g)).toHaveLength(1);
  });
  it("uses the result marker, including empty, while retaining authoritative failure metrics", () => {
    const result: ToolResultBlock = {
      type: "tool_result",
      callId: "one",
      detailKey: "outcome:0",
      isError: true,
      hasImages: false,
      headline: "Failed to inspect fixture",
    };
    const html = markup("Inspect fixture", result);
    expect(html).toContain('title="Failed to inspect fixture"');
    expect(html).not.toContain('title="Inspect fixture"');
    expect(html).toContain("1 failed");
    expect(markup("Intent", { ...result, headline: "" })).toContain(
      'class="activity-rail-headline" title=""></span>',
    );
    expect(markup("Intent", { ...result, headline: null })).not.toContain('title="Intent"');
    const { headline: _headline, ...ack } = result;
    expect(markup("Intent", ack)).toContain('title="Intent"');
  });
  it("keeps typed receipt description and status while putting supplied text only in the outcome", () => {
    const record: Extract<DisplayRecord, { type: "event" }> = {
      id: "receipt",
      parentId: null,
      timestamp: "now",
      type: "event",
      eventType: "subagent.notification",
      subagent: {
        kind: "notification",
        description: "Review",
        status: "error",
        detailKey: "receipt:subagent",
        headline: "Review failed",
      },
    };
    const html = renderToStaticMarkup(
      <SubagentNotice record={record} detailContext={detailContext()} />,
    );
    expect(html).toContain('class="activity-rail-label">Review</span>');
    expect(html).toContain('title="Review failed">Review failed</span>');
    expect(html).toContain('class="activity-rail-metric">failed</span>');
  });
});
