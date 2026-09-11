import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { errAsync, ok } from "neverthrow";
import { afterEach, beforeEach, expect, it } from "vitest";
import { composeControlPlaneDatabase } from "../adapters/database.ts";
import { PGliteClient } from "../adapters/pg/pglite-client.ts";
import { McpOAuth, type McpOAuthProtocol } from "../domain/mcp-oauth.ts";
import { FakeSecretStore } from "../testkit/broker.ts";
import { makeProjectRow } from "../testkit/fixtures.ts";
import { MCP_OAUTH_CALLBACK, registerMcpOAuthRoutes } from "./mcp-oauth-routes.ts";

const task = new NoSimulationTask("oauth-routes", false);
const projectId = "00000000-0000-4000-8000-000000000071";
const id = "00000000-0000-4000-8000-000000000072";
const path = `/api/v1/projects/${projectId}/mcp/${id}/oauth`;
let db: PGliteClient;
let apps: ReturnType<typeof Fastify>[];
let makeApp: () => ReturnType<typeof Fastify>;
let exchanges: number;
beforeEach(async () => {
  db = new PGliteClient();
  apps = [];
  exchanges = 0;
  const database = composeControlPlaneDatabase(db);
  (await database.migrate())._unsafeUnwrap();
  (await database.store.insertProject(task, makeProjectRow(projectId)))._unsafeUnwrap();
  (
    await database.mcp.replace(task, projectId, {
      revision: 0,
      servers: [
        {
          name: "fixture",
          description: "fixture",
          url: "https://mcp.example/mcp",
          headers: {},
          oauth: { id },
        },
      ],
    })
  )._unsafeUnwrap();
  const secrets = new FakeSecretStore();
  const protocol: McpOAuthProtocol = {
    prepare: async (t, binding, state) =>
      ok({
        url: `https://consent.example/authorize?state=${state}`,
        secret: {
          projectId: binding.projectId,
          connectionId: binding.id,
          access: "",
          refresh: "",
          accountId: id,
          expiresAt: t.wallNow(),
          oauth: { verifier: "private-verifier" },
        },
      }),
    exchange: async (t, value) => {
      exchanges++;
      return ok({
        ...value,
        access: "private-access",
        refresh: "private-refresh",
        expiresAt: t.wallNow() + 3_600_000,
      });
    },
    refresher: { refresh: () => errAsync({ type: "invalid_grant", message: "revoked" }) },
  };
  makeApp = () => {
    const app = Fastify();
    registerMcpOAuthRoutes(
      app,
      task,
      database.mcp,
      new McpOAuth(database.mcpOAuth, secrets, protocol),
      "https://app.example",
    );
    apps.push(app);
    return app;
  };
});
afterEach(async () => {
  for (const app of apps) await app.close();
  await db.end();
});
it("binds consent to the browser and completes after process-local state is replaced", async () => {
  const app = makeApp();
  const started = await app.inject({
    method: "POST",
    url: `${path}/connect`,
    headers: { origin: "https://app.example", "content-type": "application/json" },
    payload: {},
  });
  expect(started.statusCode).toBe(200);
  const cookie = String(started.headers["set-cookie"]);
  expect(cookie).toContain(`__Host-pi-orb-mcp-${id}=`);
  expect(cookie).toContain("Path=/;");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("HttpOnly");
  const state = new URL(started.json().url).searchParams.get("state") ?? "";
  await app.close();
  const restarted = makeApp();
  const callback = `${MCP_OAUTH_CALLBACK}?state=${state}&code=one-use-code`;
  const wrongBrowser = await restarted.inject({ url: callback });
  expect(wrongBrowser.statusCode).toBe(303);
  expect(wrongBrowser.headers.location).toBe("https://app.example/mcp/oauth/failed");
  expect(exchanges).toBe(0);
  const finished = await restarted.inject({
    url: callback,
    headers: { cookie: cookie.split(";")[0] ?? "" },
  });
  expect(finished.statusCode).toBe(303);
  expect(finished.headers.location).toBe(`https://app.example/#/projects/${projectId}/mcp`);
  expect(finished.headers["cache-control"]).toBe("no-store");
  expect(finished.headers["referrer-policy"]).toBe("no-referrer");
  expect((await restarted.inject(path)).json()).toEqual({ status: "connected" });
  const duplicate = await restarted.inject({
    url: callback,
    headers: { cookie: cookie.split(";")[0] ?? "" },
  });
  expect(duplicate.statusCode).toBe(303);
  expect(exchanges).toBe(1);
  expect(started.body + finished.body + JSON.stringify(finished.headers)).not.toMatch(
    /private-access|private-refresh|private-verifier/,
  );
});
it("rejects cross-origin mutations, missing resources and malformed callback state", async () => {
  const app = makeApp();
  for (const action of ["connect", "disconnect"]) {
    const response = await app.inject({
      method: "POST",
      url: `${path}/${action}`,
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  }
  expect(
    (await app.inject(path.replace(id, "00000000-0000-4000-8000-000000000099"))).statusCode,
  ).toBe(404);
  const malformed = await app.inject(`${MCP_OAUTH_CALLBACK}?state=one&state=two&code=secret`);
  expect(malformed.statusCode).toBe(303);
  expect(malformed.headers.location).not.toContain("secret");
  expect(exchanges).toBe(0);
  const started = await app.inject({
    method: "POST",
    url: `${path}/connect`,
    headers: { origin: "https://app.example", "content-type": "application/json" },
    payload: {},
  });
  const state = new URL(started.json().url).searchParams.get("state") ?? "";
  const denied = await app.inject({
    url: `${MCP_OAUTH_CALLBACK}?state=${state}&error=access_denied`,
    headers: { cookie: String(started.headers["set-cookie"]).split(";")[0] ?? "" },
  });
  expect(denied.statusCode).toBe(303);
  expect(denied.headers.location).toBe(
    `https://app.example/mcp/oauth/failed?projectId=${projectId}`,
  );
  expect((await app.inject(path)).json()).toEqual({ status: "auth_required" });
  expect(exchanges).toBe(0);
});
