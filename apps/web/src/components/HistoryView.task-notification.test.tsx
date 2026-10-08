import { type HistoryRecord, projectDisplayRecords } from "@pi-orb/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { computeSyncFrames } from "../../../orb-runtime/src/domain/sync.ts";
import { snapshotFromHistory } from "../lib/transcript-cache.ts";
import { detailContext } from "../testkit/display-fixtures.ts";
import { HistoryView } from "./HistoryView.tsx";

it("keeps private task deliveries out of public DTOs and cached human bubbles on full/cursor replay", () => {
  const human: HistoryRecord = {
    id: "human",
    parentId: null,
    timestamp: "t",
    type: "message",
    role: "user",
    inboxMessageIds: ["inbox"],
    overflow: {},
    content: [{ type: "text", text: "Identify all contradictions in docs!" }],
  };
  const notification: HistoryRecord = {
    id: "64ebf883-48ee-40d6-be6a-7611d5624723",
    parentId: "human",
    timestamp: "t",
    type: "message",
    role: "user",
    content: [
      { type: "text", text: "<task-notification>PRIVATE_CHILD_CANARY</task-notification>" },
    ],
    overflow: {
      native: {
        type: "user",
        origin: { kind: "task-notification", producer: "session-task" },
        promptSource: "system",
        turnOrigin: "task_notification",
      },
    },
  };
  const records = [human, notification];
  const projected = projectDisplayRecords(records);
  const cached = snapshotFromHistory({
    orbId: "orb",
    session: { id: "session" },
    records: projected,
    cursor: notification.id,
    headId: notification.id,
  });
  const html = renderToStaticMarkup(
    <HistoryView
      records={[...cached.records.values()]}
      liveBlocks={[]}
      tools={[]}
      busy={false}
      detailContext={detailContext()}
    />,
  );
  expect(html).toContain("Identify all contradictions in docs!");
  expect(html).not.toContain("PRIVATE_CHILD_CANARY");
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_CHILD_CANARY");
  expect(cached.records.has(notification.id)).toBe(true);
  for (const cursor of [null, human.id]) {
    const frames = computeSyncFrames(
      {
        orbId: "orb",
        runtimeInstanceId: "run",
        activity: "busy",
        session: { id: "session", overflow: {} },
        records,
        headId: notification.id,
      },
      null,
      cursor,
      "now",
    );
    expect(JSON.stringify(frames)).not.toContain("PRIVATE_CHILD_CANARY");
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "history.record", record: projected[1] }),
    );
  }
  const literal: HistoryRecord = { ...human, content: notification.content };
  const literalHtml = renderToStaticMarkup(
    <HistoryView
      records={projectDisplayRecords([literal])}
      liveBlocks={[]}
      tools={[]}
      busy={false}
      detailContext={detailContext()}
    />,
  );
  expect(literalHtml).toContain("PRIVATE_CHILD_CANARY");
});
