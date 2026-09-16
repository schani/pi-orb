import { NoSimulationTask } from "determined";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("session probe routes", false);

describe("browser session probe", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    app.decorateRequest("principal", undefined);
    app.addHook("onRequest", async (request: FastifyRequest) => {
      request.principal = {
        kind: "user",
        user: { id: "00000000-0000-4000-8000-000000000001", email: "dev@example.test" },
      };
    });
    registerRoutes(app, task, makeHarness().deps, {}, TEST_SYSTEM_VIEW);
    await app.ready();
  });

  afterEach(async () => app.close());

  it("returns the request-local principal without caching", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/session" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      status: "ok",
      principal: {
        kind: "user",
        user: { id: "00000000-0000-4000-8000-000000000001", email: "dev@example.test" },
      },
    });
  });
});
