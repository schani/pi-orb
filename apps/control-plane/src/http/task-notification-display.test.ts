import { DisplayHistoryViewSchema, type HistoryRecord } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("projects a persisted native task delivery without changing the audit record", async () => {
  const task = new NoSimulationTask("task delivery display", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  const auth: HistoryRecord = {
    id: "64ebf883-48ee-40d6-be6a-7611d5624723",
    parentId: null,
    timestamp: "2026-10-06T21:00:53.762Z",
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
  expect(
    (
      await harness.store.commitPullBatch(task, {
        orbId: "orb",
        expectedCursor: null,
        session: { id: "session", overflow: {} },
        records: [auth],
        nextCursor: auth.id,
        nextHeadId: auth.id,
      })
    ).isOk(),
  ).toBe(true);
  const app = Fastify({ logger: false });
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb/history" });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(Check(DisplayHistoryViewSchema, body)).toBe(true);
    expect(body.records).toEqual([
      {
        id: auth.id,
        parentId: null,
        timestamp: auth.timestamp,
        type: "event",
        eventType: "claude.task_notification",
      },
    ]);
    expect(body.cursor).toBe(auth.id);
    expect(body.headId).toBe(auth.id);
    const persisted = await harness.store.readHistorySnapshot(task, "orb");
    expect(persisted.isOk() && persisted.value.records).toEqual([auth]);
  } finally {
    await app.close();
  }
});
