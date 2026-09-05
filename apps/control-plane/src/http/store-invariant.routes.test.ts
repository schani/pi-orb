import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow, TEST_SYSTEM_VIEW } from "../testkit/fixtures.ts";
import { registerRoutes } from "./routes.ts";

const task = new NoSimulationTask("store invariant routes", false);
const MESSAGE_ID = "00000000-0000-4000-8000-000000000042";

/**
 * A deterministic store bug must not be advertised as retryable
 * (docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md): the
 * shipped enqueue failure answered 503 `unavailable` with `retryable: true`, so
 * every client — the UI included — kept re-sending a request that could never
 * succeed.
 */
describe("store invariant HTTP mapping", () => {
  let harness: ReturnType<typeof makeHarness>;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    harness = makeHarness();
    app = Fastify();
    harness.store.seedProject(makeProjectRow("project-invariant"));
    harness.store.seedOrb(makeOrbRow("orb-invariant", "project-invariant", "stopped"));
    registerRoutes(app, task, harness.deps, {}, TEST_SYSTEM_VIEW);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("answers a non-retryable 500 when enqueue hits a store invariant", async () => {
    harness.store.failWithInvariant("enqueueOrbMessage");
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/orbs/orb-invariant/messages/${MESSAGE_ID}`,
      payload: { content: [{ type: "text", text: "please continue" }] },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal");
    expect(response.json().error.retryable).toBe(false);
  });

  it("answers a non-retryable 500 when a plain read hits a store invariant", async () => {
    harness.store.failWithInvariant("getOrb");
    const response = await app.inject({ method: "GET", url: "/api/v1/orbs/orb-invariant" });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal");
    expect(response.json().error.retryable).toBe(false);
  });
});
