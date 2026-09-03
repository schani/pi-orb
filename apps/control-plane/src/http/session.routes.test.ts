import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("session probe routes", false);

describe("browser session probe", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    registerRoutes(app, task, makeHarness().deps, {});
    await app.ready();
  });

  afterEach(async () => app.close());

  it("confirms application reachability without reading domain state", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/session" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
