import websocketPlugin from "@fastify/websocket";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { ActivityHeadlineGenerationError } from "../domain/ports.ts";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerAuthenticatedBrowserRoutes } from "./browser-identity.ts";
import { registerRoutes } from "./routes.ts";

it.each([true, false])(
  "POST holds provider 503 retries before its single terminal response: recover=%s",
  async (recover) => {
    const task = new NoSimulationTask("headline HTTP retries", false);
    const h = makeHarness();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
    await h.store.commitPullBatch(task, {
      orbId: "orb",
      expectedCursor: null,
      session: { id: "session", overflow: {} },
      records: [
        {
          id: "record",
          parentId: null,
          overflow: {},
          timestamp: "2026-10-05T00:00:00Z",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_call",
              callId: "call",
              name: "codemode",
              arguments: { code: "PRIVATE_SOURCE_CANARY" },
            },
          ],
        },
      ],
      nextCursor: "record",
      nextHeadId: "record",
    });
    let calls = 0;
    const generate = vi.fn(() =>
      ++calls === 2 && recover
        ? okAsync("Recovered headline")
        : errAsync<string, ActivityHeadlineGenerationError>({
            type: "headline_generation_failed",
            stage: "inference",
            reason: "provider_error",
            providerStatus: 503,
          }),
    );
    const app = Fastify({ logger: false });
    registerRoutes(app, task, { ...h.deps, headlineGenerator: { generate } }, {}, TEST_SYSTEM_VIEW);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
      });
      expect(calls).toBe(recover ? 2 : 3);
      expect(response.statusCode).toBe(recover ? 200 : 503);
      expect(response.json()).toEqual(
        recover
          ? { headline: "Recovered headline" }
          : { error: { code: "unavailable", message: "headline unavailable", retryable: true } },
      );
      expect(response.body).not.toMatch(/PRIVATE|providerStatus|503/);
    } finally {
      await app.close();
    }
  },
);

it("POST accepts only URL identities and returns only headline; history enriches without inference", async () => {
  const task = new NoSimulationTask("headline routes", false);
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  await h.store.commitPullBatch(task, {
    orbId: "orb",
    expectedCursor: null,
    session: { id: "session", overflow: {} },
    records: [
      {
        id: "record",
        parentId: null,
        overflow: {},
        timestamp: "2026-10-04T00:00:00Z",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            callId: "call",
            name: "codemode",
            arguments: { code: "Inspect configuration" },
          },
        ],
      },
    ],
    nextCursor: "record",
    nextHeadId: "record",
  });
  const generate = vi.fn(() => okAsync("Inspect project configuration"));
  const app = Fastify({ logger: false });
  registerRoutes(app, task, { ...h.deps, headlineGenerator: { generate } }, {}, TEST_SYSTEM_VIEW);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    const cached = await app.inject({
      method: "POST",
      url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ headline: "Inspect project configuration" });
    const history = await app.inject({ method: "GET", url: "/api/v1/orbs/orb/history" });
    expect(history.json().records[0].content[0].headline).toBe("Inspect project configuration");
    expect(generate).toHaveBeenCalledOnce();
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/orbs/orb/headlines/record/record%3A0" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=wrong",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/orbs/missing/headlines/record/record%3A0?sessionId=session",
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
it("an open WS and a null initial harness session do not strand a held source POST", async () => {
  const task = new NoSimulationTask("live source", false);
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow("orb", "project", "running", { harnessSessionId: null }));
  let observed!: () => void;
  const missingRead = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const read = h.store.readHistoryRecord.bind(h.store);
  let reads = 0;
  h.store.readHistoryRecord = (...args) => {
    if (reads++ === 0) {
      observed();
      return okAsync(null);
    }
    return read(...args);
  };
  const generate = vi.fn(() => okAsync("Inspect project configuration"));
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  app.get("/live", { websocket: true }, (socket) => {
    socket.on("message", (message) => socket.send(message));
  });
  registerRoutes(app, task, { ...h.deps, headlineGenerator: { generate } }, {}, TEST_SYSTEM_VIEW);
  await app.ready();
  const socket = await app.injectWS("/live");
  try {
    const post = app.inject({
      method: "POST",
      url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
    });
    await missingRead;
    expect(generate).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
    await h.store.commitPullBatch(task, {
      orbId: "orb",
      expectedCursor: null,
      session: { id: "session", overflow: {} },
      records: [
        {
          id: "record",
          parentId: null,
          overflow: {},
          timestamp: "2026-10-04T00:00:00Z",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_call",
              callId: "call",
              name: "codemode",
              arguments: { code: "Inspect configuration" },
            },
          ],
        },
      ],
      nextCursor: "record",
      nextHeadId: "record",
    });
    expect((await post).statusCode).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
    expect(reads).toBeGreaterThan(1);
    expect(socket.readyState).toBe(1);
  } finally {
    socket.terminate();
    await app.close();
  }
});
it("authentication rejects before cache or replica access", async () => {
  const task = new NoSimulationTask("headline auth", false);
  const h = makeHarness();
  const app = Fastify({ logger: false });
  const cache = vi.spyOn(h.store, "readActivityHeadline");
  const orb = vi.spyOn(h.store, "getOrb");
  registerAuthenticatedBrowserRoutes(
    app,
    () => errAsync({ type: "unauthenticated", message: "sign in" }),
    (scope) => registerRoutes(scope, task, h.deps, {}, TEST_SYSTEM_VIEW),
  );
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
    });
    expect(response.statusCode).toBe(401);
    expect(cache).not.toHaveBeenCalled();
    expect(orb).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
