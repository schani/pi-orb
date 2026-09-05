import { SystemViewSchema } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("system routes", false);

describe("deployment facts", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    registerRoutes(app, task, makeHarness().deps, {}, TEST_SYSTEM_VIEW);
    await app.ready();
  });

  afterEach(async () => app.close());

  it("states what this deployment is made of without reading domain state", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/system" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(TEST_SYSTEM_VIEW);
    expect(Check(SystemViewSchema, response.json())).toBe(true);
  });
});
