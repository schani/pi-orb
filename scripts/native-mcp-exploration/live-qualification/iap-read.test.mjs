import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { fence, fixtureBinding, plan, sanitize, identity } = await import(
  process.env.STAGED_IAP_READ
    ? pathToFileURL(join(process.env.STAGED_IAP_READ, "iap-read.mjs")).href
    : "./iap-read.ts"
);

const servers = [
  {
    name: "cloudflare",
    description: "cloudflare MCP",
    url: "https://mcp.cloudflare.com/mcp",
    headers: {},
    oauth: { id: "1cfa006b-da21-4c11-9b5b-95cd28a9bf1b" },
  },
  {
    name: "datadog",
    description: "datadog MCP",
    url: "https://mcp.us5.datadoghq.com/v1/mcp",
    headers: {},
    oauth: { id: "c25b1857-1896-45cf-a427-a90cee36d125" },
  },
];
const catalog = { revision: 1, servers };
const orbId = "789ede6e-713a-4d7f-962c-4ff3412c78b5";
test("new IAP fixture fence rejects stale bindings, URL, revision and catalog drift", () => {
  assert.equal(fence(catalog), true);
  assert.equal(fixtureBinding("4661f85f-e70f-4ccd-b50d-2524496cb02a", catalog), true);
  assert.equal(fixtureBinding("wrong-project", catalog), false);
  for (const changed of [
    { ...catalog, revision: 2 },
    { ...catalog, servers: [servers[0]] },
    { ...catalog, servers: [servers[0], { ...servers[0] }] },
    { ...catalog, servers: [...servers, servers[0]] },
    {
      ...catalog,
      servers: [
        { ...servers[0], oauth: { id: "075be044-30ad-4933-b6fc-d7a55b9816a1" } },
        servers[1],
      ],
    },
    { ...catalog, servers: [{ ...servers[0], url: "http://localhost/mcp" }, servers[1]] },
    {
      ...catalog,
      servers: [{ ...servers[0], headers: { Authorization: { literal: "x" } } }, servers[1]],
    },
    { ...catalog, servers: [{ ...servers[0], description: "other" }, servers[1]] },
  ])
    assert.equal(fence(changed), false);
});
test("mandatory guest identity and fixed provider plan; no mode, URL or tool override", () => {
  assert.equal(
    identity(
      {
        PI_ORB_ID: orbId,
        PI_ORB_RUNTIME_TOKEN: "token",
        PI_ORB_CONTROL_PLANE_URL: "https://control.example",
      },
      orbId,
    ),
    true,
  );
  for (const id of [undefined, "", "other"])
    assert.equal(
      identity(
        {
          PI_ORB_ID: orbId,
          PI_ORB_RUNTIME_TOKEN: "token",
          PI_ORB_CONTROL_PLANE_URL: "https://control.example",
        },
        id,
      ),
      false,
    );
  assert.equal(
    identity(
      {
        PI_ORB_ID: "wrong",
        PI_ORB_RUNTIME_TOKEN: "token",
        PI_ORB_CONTROL_PLANE_URL: "https://control.example",
      },
      orbId,
    ),
    false,
  );
  assert.equal(
    identity(
      {
        PI_ORB_ID: orbId,
        PI_ORB_RUNTIME_TOKEN: "",
        PI_ORB_CONTROL_PLANE_URL: "https://control.example",
      },
      orbId,
    ),
    false,
  );
  assert.equal(plan("posthog"), null);
  assert.equal(plan("reconnect"), null);
  assert.equal(plan("cloudflare", "reject-read"), null);
  assert.deepEqual(plan("cloudflare"), {
    phase: "call",
    serverName: "cloudflare",
    toolName: "execute",
    argument: JSON.stringify({
      code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return { success: r.success, status: r.status, count: Array.isArray(r.result) ? r.result.length : 0 }; }",
    }),
  });
  assert.deepEqual(JSON.parse(plan("datadog").argument), {
    max_tokens: 1000,
    query: "status:alert priority:p1",
    telemetry: { intent: "Qualify native MCP read-only monitor search" },
  });
});
test("output projection excludes tool inventories, excerpts, raw diagnostics and tokens", () => {
  assert.deepEqual(
    sanitize({ phase: "discover", server: "cloudflare", tools: ["secret"], count: 2 }),
    { phase: "discover", server: "cloudflare", count: 2 },
  );
  assert.deepEqual(
    sanitize({ phase: "grant_before", server: "cloudflare", generation: 4, expiresAt: "secret" }),
    { phase: "grant_before", server: "cloudflare", status: "connected", generation: 4 },
  );
  assert.deepEqual(
    sanitize({
      phase: "grant_before",
      server: "cloudflare",
      code: "auth_required",
      token: "secret",
    }),
    { phase: "grant_before", server: "cloudflare", status: "auth_required" },
  );
  assert.deepEqual(
    sanitize({
      phase: "connection_failure",
      server: "cloudflare",
      state: "needs-auth",
      diagnostic: { code: "auth_required", httpStatus: 401, message: "secret" },
    }),
    {
      phase: "connection_failure",
      server: "cloudflare",
      state: "needs-auth",
      code: "auth_required",
      httpStatus: 401,
    },
  );
  assert.deepEqual(
    sanitize({
      phase: "call",
      server: "datadog",
      status: "ok",
      contentCount: 1,
      excerpt: "secret",
      application: {
        outcome: "truncated",
        displayedItems: 1,
        maxTokensHint: true,
        messageTerms: ["secret"],
      },
    }),
    {
      phase: "read",
      server: "datadog",
      status: "ok",
      contentCount: 1,
      application: { outcome: "truncated", displayedItems: 1, maxTokensHint: true },
    },
  );
  assert.deepEqual(
    sanitize({
      phase: "call",
      server: "datadog",
      status: "ok",
      application: { outcome: "success", resultCount: 0, displayedItems: 0 },
    }),
    {
      phase: "read",
      server: "datadog",
      status: "ok",
      application: { outcome: "success", resultCount: 0, displayedItems: 0 },
    },
  );
  assert.deepEqual(
    sanitize({
      phase: "call",
      server: "datadog",
      status: "ok",
      tool: "search_datadog_monitors",
      durationMs: 4,
      contentCount: 1,
      excerpt: "token",
      application: { outcome: "success", secret: "token" },
      shape: { secret: "token" },
    }),
    {
      phase: "read",
      server: "datadog",
      status: "ok",
      contentCount: 1,
      application: { outcome: "success" },
    },
  );
  assert.deepEqual(
    sanitize({
      phase: "states",
      events: [{ server: "cloudflare", state: "connected", diagnostic: { secret: "token" } }],
    }),
    { phase: "states", states: [{ server: "cloudflare", state: "connected" }] },
  );
  assert.equal(sanitize({ phase: "other", token: "token" }), null);
});
