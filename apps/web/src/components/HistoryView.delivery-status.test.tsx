import type { DisplayRecord, OrbMessageView, OrbView } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { detailContext } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";
import { OrbFailureBanner } from "./OrbFailureBanner.tsx";

const message: OrbMessageView = {
  id: "inbox",
  orbId: "orb",
  status: "queued",
  content: [{ type: "text", text: "Please check the layout." }],
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
};
function render(state: OrbView["state"], row = message, records: DisplayRecord[] = []) {
  return renderToStaticMarkup(
    <HistoryView
      orbState={state}
      records={records}
      queuedMessages={[row]}
      detailContext={detailContext()}
      liveBlocks={[]}
      tools={[]}
      busy={state === "running"}
    />,
  );
}
const label = (html: string) => html.match(/class="rec-status">([^<]*)<\/span>/)?.[1];

describe("pending delivery presentation", () => {
  it.each([
    { ...message, status: "queued" as const },
    { ...message, status: "delivering" as const },
    { ...message, status: "queued" as const, delivery: "steer" as const },
    { ...message, status: "delivering" as const, delivery: "steer" as const },
  ])("shows blocked for failed orb without changing durable row %j", (row) => {
    const before = JSON.stringify(row);
    const html = render("failed", row);
    expect(label(html)).toBe("blocked");
    expect(html).toContain("Please check the layout.");
    expect(JSON.stringify(row)).toBe(before);
  });
  it("keeps the orb failure reason only in the existing banner", () => {
    const reason = "Resource preparation failed";
    const html = renderToStaticMarkup(
      <>
        <OrbFailureBanner message={reason} />
        <HistoryView
          orbState="failed"
          records={[]}
          queuedMessages={[message]}
          detailContext={detailContext()}
          liveBlocks={[]}
          tools={[]}
          busy={false}
        />
      </>,
    );
    expect(label(html)).toBe("blocked");
    expect(html.match(/Resource preparation failed/g)).toHaveLength(1);
    expect(html).not.toContain('class="error-text"');
  });
  it.each(["stopped", "stopping", "archiving", "archived", "deleting"] as const)(
    "does not imply active delivery while %s",
    (state) => {
      expect(label(render(state, { ...message, status: "delivering" }))).toBe("paused");
      expect(label(render(state, { ...message, delivery: "steer" }))).toBe("paused");
      expect(label(render(state))).toBe("paused");
    },
  );
  it("resumes existing labels on failed → starting → running", () => {
    const row = { ...message, status: "delivering" as const };
    expect(label(render("failed", row))).toBe("blocked");
    expect(label(render("starting", row))).toBe("delivering");
    expect(label(render("running", row))).toBe("delivering");
    expect(label(render("starting"))).toBe("queued");
    expect(label(render("running", { ...message, delivery: "steer" }))).toBe("steering");
  });
  it.each(["failed", "stopped", "starting", "running"] as const)(
    "never falsely blocks or fails delivered-but-unreplicated rows while %s",
    (state) => {
      expect(label(render(state, { ...message, status: "delivered" }))).toBe("delivered");
      expect(label(render(state, { ...message, status: "delivered", delivery: "steer" }))).toBe(
        "delivered",
      );
    },
  );
  it.each(["failed", "stopped", "starting", "running"] as const)(
    "preserves actual terminal failed rows and their own reason while %s",
    (state) => {
      const html = render(state, {
        ...message,
        status: "failed",
        delivery: "steer",
        error: "Payload rejected <token>",
      });
      expect(label(html)).toBe("failed");
      expect(html.match(/Payload rejected &lt;token&gt;/g)).toHaveLength(1);
    },
  );
  it("does not rewrite canonical transcript turns even when the orb failed", () => {
    const records: DisplayRecord[] = [
      {
        id: "record",
        parentId: null,
        timestamp: message.createdAt,
        type: "message",
        role: "user",
        content: [{ type: "text", text: "Please check the layout." }],
        inboxMessageIds: [message.id],
      },
    ];
    const html = render("failed", message, records);
    expect(label(html)).toBeUndefined();
    expect(html).not.toContain("rec-q");
    expect(html.match(/Please check the layout/g)).toHaveLength(1);
  });
});
