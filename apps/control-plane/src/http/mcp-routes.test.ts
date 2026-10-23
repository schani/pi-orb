import type { McpCatalog } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { registerMcpRoutes } from "./mcp-routes.ts";

it("roundtrips HTTPS OAuth catalogs, rejects isolated invalid fields and preserves missing URLs", async () => {
  const projectId = "00000000-0000-4000-8000-000000000098";
  const path = `/api/v1/projects/${projectId}/mcp`;
  let catalog: McpCatalog = { revision: 0, servers: [] };
  const writes: string[] = [];
  const app = Fastify();
  registerMcpRoutes(app, new NoSimulationTask("routes", false), {
    read: (_task, id) =>
      id === projectId
        ? okAsync(catalog)
        : errAsync({
            type: "mcp_config_error",
            code: "not_found",
            message: "Project doesn't exist",
          }),
    replace: (_task, id, value) => {
      writes.push(id);
      catalog = { ...value, revision: value.revision + 1 };
      return okAsync(catalog);
    },
  });
  try {
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-4000-8000-000000000099/mcp",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    expect(missing.headers.location).toBeUndefined();

    const server = {
      name: "metrics",
      description: "Metrics",
      url: "https://example.com/mcp",
      headers: { "X-Project": { literal: "project-a" } },
      oauth: { id: "00000000-0000-4000-8000-000000000091" },
    };
    const other = {
      ...server,
      name: "logs",
      oauth: { id: "00000000-0000-4000-8000-000000000092" },
    };
    const valid = await app.inject({
      method: "PUT",
      url: path,
      payload: { revision: 0, servers: [server, other] },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ revision: 1, servers: [server, other] });
    expect(valid.headers["cache-control"]).toBe("no-store");
    const readback = await app.inject({ method: "GET", url: path });
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toEqual(valid.json());
    expect(readback.headers["cache-control"]).toBe("no-store");

    const denials = [
      { name: "HTTP", servers: [{ ...server, url: "http://example.com/mcp" }, other] },
      { name: "description", servers: [{ ...server, description: undefined }, other] },
      { name: "headers", servers: [{ ...server, headers: undefined }, other] },
      { name: "OAuth binding", servers: [{ ...server, oauth: {} }, other] },
      { name: "OAuth ID", servers: [{ ...server, oauth: { id: "not-a-uuid" } }, other] },
      { name: "duplicate OAuth ID", servers: [server, { ...other, oauth: server.oauth }] },
      { name: "duplicate name", servers: [server, { ...other, name: server.name }] },
      {
        name: "OAuth Authorization conflict",
        servers: [
          { ...server, headers: { ...server.headers, aUtHoRiZaTiOn: { literal: "Bearer token" } } },
          other,
        ],
      },
      {
        name: "URL credentials",
        servers: [{ ...server, url: "https://user:pass@example.com/mcp" }, other],
      },
      {
        name: "URL fragment",
        servers: [{ ...server, url: "https://example.com/mcp#fragment" }, other],
      },
    ];
    for (const { name, servers } of denials) {
      const invalid = await app.inject({
        method: "PUT",
        url: path,
        payload: { revision: 1, servers },
      });
      expect(invalid.statusCode, name).toBe(400);
      expect(invalid.json().error, name).toMatchObject({
        code: "invalid_request",
        retryable: false,
      });
      const unchanged = await app.inject({ method: "GET", url: path });
      expect(unchanged.statusCode, name).toBe(200);
      expect(unchanged.json(), name).toEqual(valid.json());
      expect(writes, name).toEqual([projectId]);
    }
    const cleared = await app.inject({
      method: "PUT",
      url: path,
      payload: { revision: 1, servers: [] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ revision: 2, servers: [] });
  } finally {
    await app.close();
  }
});
