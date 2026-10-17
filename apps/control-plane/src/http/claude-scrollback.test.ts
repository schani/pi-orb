import { type HistoryRecord, projectDisplayRecords } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("serves stopped Claude scrollback across a null-parent compaction without waking the orb", async () => {
  const task = new NoSimulationTask("Claude compaction scrollback", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped", { harness: "claude" }));
  const runtimeCalls = (
    [
      "deliverMessage",
      "health",
      "prepareIdleStop",
      "readDisplayDetail",
      "readLiveDisplayDetail",
      "readDisplayImage",
      "pullHistory",
    ] as const
  ).map((method) => vi.spyOn(harness.deps.runtimeClient, method));
  const start = vi.spyOn(harness.deps.hostProvider, "start");
  const session = { id: "claude-session", timestamp: "2026-10-16T00:00:00.000Z", overflow: {} };
  const base = (id: string, parentId: string | null, second: number) => ({
    id,
    parentId,
    timestamp: `2026-10-16T00:00:0${second}.000Z`,
    overflow: {},
  });
  const records: HistoryRecord[] = [
    {
      ...base("old-human", null, 1),
      type: "message",
      role: "user",
      inboxMessageIds: ["human-inbox"],
      content: [{ type: "text", text: "Keep this earlier request." }],
    },
    {
      ...base("boundary", null, 2),
      type: "event",
      eventType: "claude.compact_boundary",
    },
    {
      ...base("summary", "boundary", 3),
      type: "compaction",
      summary: [{ type: "text", text: "Earlier context summarized." }],
    },
    {
      ...base("new-assistant", "summary", 4),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Continuing after compaction." }],
    },
    {
      ...base("cursor", "new-assistant", 5),
      type: "event",
      eventType: "claude.result",
    },
  ];
  const before = await harness.store.commitPullBatch(task, {
    orbId: "orb",
    expectedCursor: null,
    session,
    records: records.slice(0, 1),
    nextCursor: "old-human",
    nextHeadId: "old-human",
  });
  expect(before.isOk()).toBe(true);
  const committed = await harness.store.commitPullBatch(task, {
    orbId: "orb",
    expectedCursor: "old-human",
    session,
    records: records.slice(1),
    nextCursor: "cursor",
    nextHeadId: "new-assistant",
  });
  expect(committed.isOk()).toBe(true);
  const app = Fastify({ logger: false });
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb/history" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      orbId: "orb",
      session: { id: session.id, timestamp: session.timestamp },
      cursor: "cursor",
      headId: "new-assistant",
      records: projectDisplayRecords(records),
    });
    expect(body.records[0]).toMatchObject({ role: "user", inboxMessageIds: ["human-inbox"] });
    for (const call of runtimeCalls) expect(call).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
