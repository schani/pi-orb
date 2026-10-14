import {
  type DisplayRecord,
  type HistoryRecord,
  type OrbMessageView,
  type OrbView,
  projectDisplayRecords,
} from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createInboxPoller } from "../lib/inbox-poller.ts";
import { messagesAwaitingHistory } from "../lib/queued-messages.ts";
import { snapshotFromHistory } from "../lib/transcript-cache.ts";
import { detailContext } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";

const senderId = "629e53de-a2c9-4f1b-87a6-437fd415e8de";
const body =
  '<script>globalThis.__peerInjected = true</script>\n<img src=x onerror="bad()"> & "quotes"\n**literal**\n' +
  "snapshot-".repeat(90);
const pending: OrbMessageView = {
  id: "peer-inbox",
  orbId: "receiver",
  status: "queued",
  content: [{ type: "text", text: body }],
  system: { kind: "orb_message", senderOrbId: senderId },
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};
const receipt: HistoryRecord = {
  id: "peer-record",
  parentId: null,
  timestamp: pending.createdAt,
  type: "event",
  eventType: "orb.message",
  sender: { orbId: senderId },
  content: pending.content,
  inboxMessageIds: [pending.id],
  overflow: {},
};
function render(
  records: readonly DisplayRecord[] = [],
  rows: readonly OrbMessageView[] = [],
  state: OrbView["state"] = "running",
  names: ReadonlyMap<string, string | null> = new Map([[senderId, "runtime handshake"]]),
) {
  return renderToStaticMarkup(
    <HistoryView
      records={records}
      queuedMessages={rows}
      orbState={state}
      senderNames={names}
      detailContext={detailContext()}
      liveBlocks={[]}
      tools={[]}
      busy={false}
    />,
  );
}
function assertPeer(html: string) {
  expect(html.match(/class="rec rec-peer(?: rec-q)?"/g)).toHaveLength(1);
  expect(html).toContain(`href="/orbs/${senderId}"`);
  expect(html).toContain('class="peer-body"');
  expect(html).toContain("&lt;script&gt;globalThis.__peerInjected = true&lt;/script&gt;\n");
  expect(html).toContain(`**literal**\n${"snapshot-".repeat(90)}`);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<strong>literal</strong>");
  const band = html.match(/<article class="rec rec-peer[^"]*"[^>]*>([\s\S]*?)<\/article>/)?.[1];
  expect(band).toBeDefined();
  expect(band).not.toContain("chat-markdown");
}

describe("orb correspondence", () => {
  it("uses trusted source, full literal text, and a linked current sender between white replies", () => {
    const assistant = (id: string): HistoryRecord => ({
      id,
      parentId: null,
      timestamp: pending.createdAt,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: id }],
      overflow: {},
    });
    const records = projectDisplayRecords([assistant("before"), receipt, assistant("after")]);
    const html = render(records);
    assertPeer(html);
    expect(html).toContain(">runtime handshake</a>");
    expect(html.match(/class="rec rec-orb"/g)).toHaveLength(2);
    expect(html).not.toContain("rec-you");
    expect(html.indexOf("before")).toBeLessThan(html.indexOf("peer-body"));
    expect(html.indexOf("peer-body")).toBeLessThan(html.indexOf("after"));
  });

  it("keeps multi-block text unchanged at the pending/history handoff", () => {
    const content = [
      { type: "text" as const, text: "first\n" },
      { type: "text" as const, text: "second" },
    ];
    const text = (html: string) => html.match(/class="peer-body">([\s\S]*?)<\/div>/)?.[1];
    expect(text(render([], [{ ...pending, content }]))).toBe(
      text(render(projectDisplayRecords([{ ...receipt, content }]))),
    );
  });

  it("never infers peer provenance from human text or inbox correlation", () => {
    const human: HistoryRecord = {
      ...receipt,
      type: "message",
      role: "user",
      content: [{ type: "text", text: `orb.message from ${senderId}` }],
    };
    const html = render(projectDisplayRecords([human]));
    expect(html).toContain('class="rec rec-you"');
    expect(html).not.toContain("rec-peer");
    expect(html).not.toContain('href="/orbs/');
    const { system: _system, ...humanPending } = pending;
    expect(render([], [humanPending])).not.toContain("rec-peer");
    expect(
      render(projectDisplayRecords([{ ...receipt, eventType: "custom.message" }])),
    ).not.toContain("rec-peer");
  });

  it.each([
    ["queued", "running", "queued"],
    ["delivering", "running", "delivering"],
    ["queued", "failed", "blocked"],
    ["delivering", "failed", "blocked"],
    ["queued", "stopped", "paused"],
    ["delivered", "failed", "delivered"],
    ["failed", "running", "failed"],
  ] as const)("retains sender and literal body for %s while %s", (status, state, label) => {
    const html = render(
      [],
      [
        {
          ...pending,
          status,
          ...(status === "failed" ? { error: "Delivery rejected <token>" } : {}),
        },
      ],
      state,
    );
    assertPeer(html);
    expect(html).toContain(`class="rec-status">${label}</span>`);
    expect(html).toContain(">runtime handshake</a>");
    if (status === "failed") expect(html.match(/Delivery rejected &lt;token&gt;/g)).toHaveLength(1);
  });

  it("uses fresh names without changing stored attribution; unnamed/missing/deleted senders retain ID and link", () => {
    const records = projectDisplayRecords([receipt]);
    const before = JSON.stringify(records);
    expect(render(records, [], "running", new Map([[senderId, "renamed <sender>"]]))).toContain(
      "renamed &lt;sender&gt;</a>",
    );
    for (const names of [new Map(), new Map([[senderId, null]]), new Map([[senderId, ""]])]) {
      const html = render(records, [], "running", names);
      expect(html).toContain(`href="/orbs/${senderId}"`);
      expect(html).toContain(`>${senderId}</a>`);
    }
    expect(JSON.stringify(records)).toBe(before);
  });

  it("keeps pending attribution through poll failure/status-only updates, then hands off by inbox ID on reload", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(ok({ items: [pending], updates: [], cursor: 1 }))
      .mockResolvedValueOnce(err({ type: "network", message: "offline" }))
      .mockResolvedValueOnce(
        ok({
          items: [],
          updates: [
            {
              id: pending.id,
              orbId: pending.orbId,
              status: "delivered",
              createdAt: pending.createdAt,
              updatedAt: pending.updatedAt,
            },
          ],
          cursor: 1,
        }),
      );
    const poller = createInboxPoller(read);
    await poller.poll(() => true);
    assertPeer(render([], poller.rows()));
    expect((await poller.poll(() => true)).isErr()).toBe(true);
    assertPeer(render([], poller.rows(), "failed"));
    await poller.poll(() => true);
    expect(poller.rows()[0]?.system).toEqual(pending.system);
    expect(render([], poller.rows())).toContain('class="rec-status">delivered</span>');
    const snapshot = snapshotFromHistory({
      orbId: pending.orbId,
      session: { id: "session" },
      records: projectDisplayRecords([receipt]),
      cursor: receipt.id,
      headId: receipt.id,
    });
    const reloaded = [...snapshot.records.values()];
    const html = render(reloaded, poller.rows());
    assertPeer(html);
    expect(html).not.toContain("rec-q");
    expect(html).not.toContain("rec-status");
    expect(messagesAwaitingHistory(poller.rows(), reloaded)).toEqual([]);
    const unrelated = projectDisplayRecords([
      { ...receipt, id: "other", inboxMessageIds: ["other-inbox"] },
    ]);
    expect(messagesAwaitingHistory(poller.rows(), unrelated)).toEqual(poller.rows());
  });
});
