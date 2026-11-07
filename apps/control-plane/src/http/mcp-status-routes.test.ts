import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import type { McpHealthDeps } from "../domain/mcp.ts";
import { makeHarness, makeProjectRow, TEST_USER_ID } from "../testkit/fixtures.ts";
import { registerProjectMcpStatusRoute } from "./mcp-routes.ts";

it("requires identity and project ownership before checking saved servers", async () => {
  const h = makeHarness();
  const task = new NoSimulationTask("MCP HTTP", false);
  h.store.seedProject(makeProjectRow("project"));
  const probe = vi.fn<McpHealthDeps["probe"]>(async () => ok(undefined));
  const catalog = {
    read: vi.fn(() =>
      okAsync({
        revision: 1,
        servers: [
          { name: "fixture", description: "Fixture", url: "https://mcp.example", headers: {} },
        ],
      }),
    ),
  };
  const oauth = { token: vi.fn<McpHealthDeps["oauth"]["token"]>() };
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization)
      request.principal = {
        kind: "user",
        user: { id: request.headers.authorization, email: null },
      };
  });
  registerProjectMcpStatusRoute(app, task, h.deps.userScope, {
    store: h.store,
    catalog,
    projectSecrets: h.deps.projectSecrets,
    oauth,
    probe,
  });
  try {
    const url = "/api/v1/projects/project/mcp/status";
    expect((await app.inject(url)).statusCode).toBe(401);
    for (const [target, owner] of [
      [url, "other"],
      ["/api/v1/projects/missing/mcp/status", TEST_USER_ID],
    ] as const) {
      const missing = await app.inject({ url: target, headers: { authorization: owner } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.message).toBe("Project doesn't exist");
      expect(missing.headers.location).toBeUndefined();
    }
    expect(catalog.read).not.toHaveBeenCalled();
    expect(oauth.token).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers: { authorization: TEST_USER_ID } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      revision: 1,
      servers: [{ name: "fixture", status: "available" }],
    });
  } finally {
    await app.close();
  }
});
