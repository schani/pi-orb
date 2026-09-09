import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { registerMcpRoutes } from "./mcp-routes.ts";

it("validates catalogs, never accepts OAuth, and preserves a missing project's URL", async () => {
  const app = Fastify();
  registerMcpRoutes(app, new NoSimulationTask("routes", false), {
    read: () =>
      errAsync({ type: "mcp_config_error", code: "not_found", message: "Project doesn't exist" }),
    replace: (_t, _p, value) => okAsync({ ...value, revision: value.revision + 1 }),
  });
  try {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000099/mcp",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.location).toBeUndefined();
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000099/mcp",
      payload: { revision: 0, servers: [{ name: "x", url: "http://localhost/", oauth: {} }] },
    });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000099/mcp",
      payload: { revision: 0, servers: [] },
    });
    expect(valid.json()).toEqual({ revision: 1, servers: [] });
  } finally {
    await app.close();
  }
});
