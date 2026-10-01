import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("validates alert acknowledgement and returns the surviving pointer", async () => {
  const task = new NoSimulationTask("alert route", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  harness.store.seedOrb(makeOrbRow("other", "project", "stopped"));
  const record = {
    id: "alert",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "event" as const,
    eventType: "pi.custom",
    content: [{ type: "text" as const, text: "private" }],
    alert: { message: "private", requestId: "request" },
    overflow: {},
  };
  (
    await harness.store.commitPullBatch(task, {
      orbId: "orb",
      expectedCursor: null,
      session: { id: "session", overflow: {} },
      records: [record],
      nextCursor: record.id,
      nextHeadId: record.id,
    })
  )._unsafeUnwrap();
  const app = Fastify({ logger: false });
  registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
  try {
    const post = (orbId: string, payload: object) =>
      app.inject({ method: "POST", url: `/api/v1/orbs/${orbId}/alerts/ack`, payload });
    expect((await post("orb", {})).statusCode).toBe(400);
    expect((await post("missing", { recordId: "alert" })).statusCode).toBe(404);
    expect((await post("other", { recordId: "alert" })).statusCode).toBe(409);
    expect((await post("orb", { recordId: "unknown" })).statusCode).toBe(409);
    expect((await post("orb", { recordId: "alert" })).json()).toEqual({ unreadAlertId: null });
    expect((await post("orb", { recordId: "alert" })).json()).toEqual({ unreadAlertId: null });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/orbs/orb" })).json(),
    ).not.toHaveProperty("unreadAlertId");
  } finally {
    await app.close();
  }
});
