import { type HistoryRecord, projectDisplayRecords } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { snapshotFromHistory } from "../lib/transcript-cache.ts";
import { detailContext } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";

it("does not place attachment status before the first human turn after cache/reconnect", () => {
  const auth: HistoryRecord = {
    id: "e6903b82-aaa5-408a-9275-c0f516275b2c",
    parentId: null,
    timestamp: "2026-10-06T21:00:53.762Z",
    type: "event",
    eventType: "claude.auth",
    custom: { customType: "claude.auth", display: true },
    content: [{ type: "text", text: "Claude subscription connected." }],
    overflow: { generation: 1 },
  };
  const human: HistoryRecord = {
    id: "human",
    parentId: null,
    timestamp: "t",
    type: "message",
    role: "user",
    content: [{ type: "text", text: "Identify all contradictions in docs!" }],
    inboxMessageIds: ["inbox"],
    overflow: {},
  };
  const records = [auth, human];
  const snapshot = snapshotFromHistory({
    orbId: "orb",
    session: { id: "session" },
    cursor: "human",
    headId: "human",
    records: projectDisplayRecords(records),
  });
  const html = renderToStaticMarkup(
    <HistoryView
      records={[...snapshot.records.values()]}
      liveBlocks={[]}
      tools={[]}
      busy={false}
      detailContext={detailContext()}
    />,
  );
  expect(html).toContain("Identify all contradictions in docs!");
  expect(html).not.toContain("Claude subscription connected.");
  expect(html).not.toContain("record-custom");
  expect(snapshot.records.has(auth.id)).toBe(true);
  const identicalHuman: HistoryRecord = {
    ...human,
    content: [{ type: "text", text: "Claude subscription connected." }],
  };
  const literalHtml = renderToStaticMarkup(
    <HistoryView
      records={projectDisplayRecords([auth, identicalHuman])}
      liveBlocks={[]}
      tools={[]}
      busy={false}
      detailContext={detailContext()}
    />,
  );
  expect(literalHtml).toContain("Claude subscription connected.");
});
