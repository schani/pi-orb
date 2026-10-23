import { DisplayHistoryViewSchema, type HistoryRecord } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { openDisplayHistory } from "../testkit/display-history.ts";

it("projects a persisted native task delivery as a delivery row without changing the audit record", async () => {
  const auth: HistoryRecord = {
    id: "64ebf883-48ee-40d6-be6a-7611d5624723",
    parentId: null,
    timestamp: "2026-10-06T21:00:53.762Z",
    type: "message",
    role: "user",
    content: [
      {
        type: "text",
        text: "<task-notification>\n<summary>Child finished</summary>\n</task-notification>",
      },
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
  const { app, harness, task } = await openDisplayHistory([auth]);
  {
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
        eventType: "agent.delivery",
        delivery: { kind: "task", headline: "Child finished", detailKey: `${auth.id}:delivery` },
      },
    ]);
    expect(body.cursor).toBe(auth.id);
    expect(body.headId).toBe(auth.id);
    const persisted = await harness.store.readHistorySnapshot(task, "orb");
    expect(persisted.isOk() && persisted.value.records).toEqual([auth]);
  }
});
