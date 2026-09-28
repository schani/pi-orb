import { OrbHistoryViewSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

it("streams the browser's complete history schema including session and cursor metadata", async () => {
  const task = new NoSimulationTask("history route", false);
  const log = vi.spyOn(task, "log");
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  const record = {
    id: "record",
    parentId: null,
    timestamp: "2026-08-27T00:00:00.000Z",
    type: "message" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text: "x".repeat(33 * 1024 * 1024) }],
    overflow: { native: { payload: true } },
  };
  const session = { id: "session", overflow: { native: { id: "session" } } };
  expect(
    (
      await harness.store.commitPullBatch(task, {
        orbId: "orb",
        expectedCursor: null,
        session,
        records: [record],
        nextCursor: record.id,
        nextHeadId: record.id,
      })
    ).isOk(),
  ).toBe(true);
  const app = Fastify({ logger: false });
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb/history" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect(Check(OrbHistoryViewSchema, response.json())).toBe(true);
    expect(response.body).toBe(
      JSON.stringify({
        orbId: "orb",
        session,
        cursor: record.id,
        headId: record.id,
        records: [record],
      }),
    );
    expect(Buffer.byteLength(response.body)).toBeGreaterThan(32 * 1024 * 1024);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^lifecycle: orb=orb history-streamed producedBytes=\d+ totalRecords=1$/,
      ),
    );
  } finally {
    await app.close();
  }
});
