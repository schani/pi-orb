import websocketPlugin from "@fastify/websocket";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { ActivityHeadlineGenerationError } from "../domain/ports.ts";
import { headlineSource, seedDisplayHistory } from "../testkit/display-history.ts";
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
    await seedDisplayHistory(task, h, [
      headlineSource("PRIVATE_SOURCE_CANARY", "2026-10-05T00:00:00Z"),
    ]);
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
  await seedDisplayHistory(task, h, [headlineSource()]);
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
    await seedDisplayHistory(task, h, [headlineSource()]);
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

it.each(["invalidated", "unavailable", "invariant", "corruption"] as const)(
  "POST distinguishes fenced persistence from %s failures without leaking diagnostics",
  async (outcome) => {
    const task = new NoSimulationTask("persistence HTTP", false);
    const h = makeHarness();
    h.store.seedProject(makeProjectRow("project"));
    h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
    await seedDisplayHistory(task, h, [headlineSource("PRIVATE_SOURCE_CANARY")]);
    const write = vi.spyOn(h.store, "putActivityHeadlineIfAbsent").mockReturnValueOnce(
      outcome === "invalidated"
        ? okAsync(null)
        : errAsync({
            type: "store_error",
            code: outcome,
            retryable: outcome === "unavailable",
            message: "PRIVATE_SQL_MESSAGE",
            sqlState: "42P01",
          }),
    );
    const app = Fastify({ logger: false });
    registerRoutes(app, task, h.deps, {}, TEST_SYSTEM_VIEW);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
      });
      expect(write).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(outcome === "invalidated" ? 409 : 503);
      expect(response.json()).toEqual({
        error:
          outcome === "invalidated"
            ? { code: "conflict", message: "headline source changed", retryable: false }
            : {
                code: "unavailable",
                message: "headline unavailable",
                retryable: outcome === "unavailable",
              },
      });
      expect(response.body).not.toMatch(/PRIVATE|42P01|sqlState|store_error/);
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await app.close();
    }
  },
);

it("POST cannot persist after deletion wins the final store fence", async () => {
  const task = new NoSimulationTask("deleted headline HTTP", false);
  const h = makeHarness();
  h.store.seedProject(makeProjectRow("project"));
  h.store.seedOrb(makeOrbRow("orb", "project", "stopped"));
  await seedDisplayHistory(task, h, [headlineSource()]);
  const generate = vi.fn(() => okAsync("PRIVATE_HEADLINE_CANARY"));
  const put = h.store.putActivityHeadlineIfAbsent.bind(h.store);
  const write = vi.spyOn(h.store, "putActivityHeadlineIfAbsent").mockImplementationOnce(
    (t, candidate) =>
      new ResultAsync(
        (async () => {
          const deleting = (
            await h.store.requestOrbDeletion(t, {
              orbId: "orb",
              expectedStateVersion: 0,
              now: t.wallNow(),
              cleanupAfter: t.wallNow(),
            })
          )._unsafeUnwrap();
          (
            await h.store.finalizeOrbDeletion(t, {
              orbId: "orb",
              expectedStateVersion: deleting.stateVersion,
            })
          )._unsafeUnwrap();
          return await put(t, candidate);
        })(),
      ),
  );
  const app = Fastify({ logger: false });
  registerRoutes(app, task, { ...h.deps, headlineGenerator: { generate } }, {}, TEST_SYSTEM_VIEW);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orbs/orb/headlines/record/record%3A0?sessionId=session",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "conflict", message: "headline source changed", retryable: false },
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect((await h.store.readActivityHeadlines(task, "orb", "session"))._unsafeUnwrap()).toEqual(
      [],
    );
    expect((await h.store.getOrb(task, "orb"))._unsafeUnwrap()).toBeNull();
    expect(response.body).not.toContain("PRIVATE");
  } finally {
    await app.close();
  }
});
