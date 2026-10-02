import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import {
  makeHarness,
  makeOrbRow,
  makeProjectRow,
  seedRunningOrb,
  TEST_SYSTEM_VIEW,
  TEST_USER_ID,
} from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

function authenticatedApp(userId = TEST_USER_ID) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    request.principal = { kind: "user", user: { id: userId, email: null } };
  });
  return app;
}

it("reads committed detail without compute, distinguishes missing detail from missing orb, and rejects stale sessions", async () => {
  const task = new NoSimulationTask("committed detail", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "archived"));
  const secret = "HIDDEN_DETAIL_BODY";
  const record = {
    id: "r1",
    parentId: null,
    timestamp: "2026-10-02T00:00:00.000Z",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "reasoning" as const, text: secret }],
    overflow: { native: secret },
  };
  expect(
    (
      await harness.store.commitPullBatch(task, {
        orbId: "orb",
        expectedCursor: null,
        session: { id: "session", overflow: {} },
        records: [record],
        nextCursor: "r1",
        nextHeadId: "r1",
      })
    ).isOk(),
  ).toBe(true);
  const observe = vi.spyOn(harness.deps.hostProvider, "observe");
  const snapshot = vi.spyOn(harness.store, "readHistorySnapshot");
  const app = authenticatedApp();
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const url = "/api/v1/orbs/orb/details/r1/r1%3A0?sessionId=session";
    const result = await app.inject({ method: "GET", url });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      state: "committed",
      sessionId: "session",
      recordId: "r1",
      body: { type: "reasoning", text: secret },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/orbs/orb/details/r1/r1%3A9?sessionId=session",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/orbs/missing/details/r1/r1%3A0?sessionId=session",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/orbs/orb/details/r1/r1%3A0?sessionId=other",
        })
      ).statusCode,
    ).toBe(409);
    expect(observe).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("allows an authenticated coworker to read company-wide orb detail", async () => {
  const task = new NoSimulationTask("coworker detail", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  const record = {
    id: "r1",
    parentId: null,
    timestamp: "2026-10-02T00:00:00.000Z",
    type: "message" as const,
    role: "assistant" as const,
    content: [{ type: "reasoning" as const, text: "shared" }],
    overflow: {},
  };
  expect(
    (
      await harness.store.commitPullBatch(task, {
        orbId: "orb",
        expectedCursor: null,
        session: { id: "session", overflow: {} },
        records: [record],
        nextCursor: "r1",
        nextHeadId: "r1",
      })
    ).isOk(),
  ).toBe(true);
  const app = authenticatedApp("coworker");
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const result = await app.inject({
      method: "GET",
      url: "/api/v1/orbs/orb/details/r1/r1%3A0?sessionId=session",
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().body.text).toBe("shared");
  } finally {
    await app.close();
  }
});

it("serves separate binary images from the authorized replica session", async () => {
  const task = new NoSimulationTask("replica image", false);
  const harness = makeHarness();
  harness.store.seedProject(makeProjectRow("project"));
  harness.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  const data = Buffer.from("binary image");
  const record = {
    id: "r1",
    parentId: null,
    timestamp: "2026-10-02T00:00:00.000Z",
    type: "message" as const,
    role: "user" as const,
    content: [{ type: "image" as const, mediaType: "image/png", data: data.toString("base64") }],
    overflow: {},
  };
  expect(
    (
      await harness.store.commitPullBatch(task, {
        orbId: "orb",
        expectedCursor: null,
        session: { id: "session", overflow: {} },
        records: [record],
        nextCursor: "r1",
        nextHeadId: "r1",
      })
    ).isOk(),
  ).toBe(true);
  const app = authenticatedApp();
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const path = "/api/v1/orbs/orb/images/r1/r1%3A0/0?sessionId=session";
    const result = await app.inject({ method: "GET", url: path });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.rawPayload).toEqual(data);
    expect(
      (
        await app.inject({
          method: "GET",
          url: path.replace("sessionId=session", "sessionId=other"),
        })
      ).statusCode,
    ).not.toBe(200);
  } finally {
    await app.close();
  }
});

it("rejects a runtime detail response after deletion wins the in-flight read", async () => {
  const task = new NoSimulationTask("detail deletion fence", false);
  const harness = makeHarness();
  seedRunningOrb(task, harness, "orb");
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(harness.deps.runtimeClient, "readDisplayDetail").mockImplementation(
    () =>
      new ResultAsync(
        (async () => {
          started();
          await held;
          return ok({
            v: 1 as const,
            sessionId: "session",
            recordId: "r1",
            detailKey: "r1:0",
            state: "committed" as const,
            body: { type: "reasoning" as const, text: "old host secret" },
          });
        })(),
      ),
  );
  const app = authenticatedApp();
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const pending = app.inject({
      method: "GET",
      url: "/api/v1/orbs/orb/details/r1/r1%3A0?sessionId=session",
    });
    await entered;
    harness.store.seedOrb(makeOrbRow("orb", "project-of-orb", "deleting"));
    release();
    const result = await pending;
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("old host secret");
  } finally {
    await app.close();
  }
});

it("chooses current runtime for an unreplicated running record without wake", async () => {
  const task = new NoSimulationTask("runtime detail", false);
  const harness = makeHarness();
  seedRunningOrb(task, harness, "orb");
  // Host fixture starts with a session; an explicit runtime client stub models a record ahead of replication.
  const runtime = vi.spyOn(harness.deps.runtimeClient, "readDisplayDetail").mockImplementation(() =>
    okAsync({
      v: 1,
      sessionId: "session",
      recordId: "r1",
      detailKey: "r1:0",
      state: "committed",
      body: { type: "reasoning", text: "runtime detail" },
    }),
  );
  const app = authenticatedApp();
  try {
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    const result = await app.inject({
      method: "GET",
      url: "/api/v1/orbs/orb/details/r1/r1%3A0?sessionId=session",
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().body.text).toBe("runtime detail");
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(harness.store.orbSnapshot("orb")?.state).toBe("running");
  } finally {
    await app.close();
  }
});
