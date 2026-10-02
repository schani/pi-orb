import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { fixtureBinding, qualificationInput, identity, sanitize, verifiedRead } = await import(
  process.env.STAGED_GLIDEOS_READ
    ? pathToFileURL(join(process.env.STAGED_GLIDEOS_READ, "glideos-read.mjs")).href
    : "./glideos-read.ts"
);
const project = "35f581fb-7bbf-4542-a1e8-0d047657a71d";
const cloudflare = {
  name: "cloudflare",
  description: "cloudflare MCP",
  url: "https://mcp.cloudflare.com/mcp",
  headers: {},
  oauth: { id: "406a3aeb-7e46-492e-b56a-07364453d511" },
};
const datadog = {
  name: "datadog",
  description: "datadog MCP",
  url: "https://mcp.us5.datadoghq.com/v1/mcp",
  headers: {},
  oauth: { id: "e2c2ee5c-0fc9-4133-8f41-d333ed5e46c9" },
};
const posthog = {
  name: "posthog",
  url: "https://mcp.posthog.com/mcp",
  headers: { Authorization: { secret: "NEVER_FETCH_POSTHOG_KEY" } },
};
const catalog = { revision: 3, servers: [posthog, datadog, cloudflare] };
const orbId = "789ede6e-713a-4d7f-962c-4ff3412c78b5";

test("GlideOS catalog guard selects only approved OAuth configs, never PostHog or its secret", () => {
  const selected = fixtureBinding(project, catalog);
  assert.deepEqual(selected, { revision: 3, servers: [datadog, cloudflare] });
  assert.equal(JSON.stringify(selected).includes("NEVER_FETCH_POSTHOG_KEY"), false);
  assert.equal(fixtureBinding("4661f85f-e70f-4ccd-b50d-2524496cb02a", catalog), null);
  assert.equal(qualificationInput(project, catalog, "posthog"), null);
  assert.equal(qualificationInput(project, catalog, "reconnect"), null);
  assert.equal(qualificationInput(project, catalog, "cloudflare", "reject-read"), null);
  assert.deepEqual(qualificationInput(project, catalog, "cloudflare"), {
    catalog: selected,
    phase: "call",
    serverName: "cloudflare",
    toolName: "execute",
    argument: JSON.stringify({
      code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return { success: r.success, status: r.status, count: Array.isArray(r.result) ? r.result.length : 0 }; }",
    }),
  });
  const dd = qualificationInput(project, catalog, "datadog");
  assert.deepEqual(dd.catalog, selected);
  assert.deepEqual(JSON.parse(dd.argument), {
    max_tokens: 1000,
    query: "status:alert priority:p1",
    telemetry: { intent: "Qualify native MCP read-only monitor search" },
  });
});

test("reject foreign, duplicate, unknown or changed bindings before any broker grant", () => {
  for (const changed of [
    { ...catalog, revision: 4 },
    { ...catalog, servers: [cloudflare, datadog] },
    { ...catalog, servers: [posthog, cloudflare, cloudflare] },
    { ...catalog, servers: [posthog, cloudflare, datadog, cloudflare] },
    { ...catalog, servers: [posthog, cloudflare, { ...datadog, name: "unknown" }] },
    {
      ...catalog,
      servers: [posthog, cloudflare, { ...datadog, oauth: { id: cloudflare.oauth.id } }],
    },
    { ...catalog, servers: [posthog, cloudflare, { ...datadog, url: "https://example.com/mcp" }] },
    {
      ...catalog,
      servers: [posthog, cloudflare, { ...datadog, headers: { Authorization: { literal: "x" } } }],
    },
    { ...catalog, servers: [posthog, { ...cloudflare, oauth: undefined }, datadog] },
    {
      ...catalog,
      servers: [posthog, { ...cloudflare, headers: { Authorization: { secret: "x" } } }, datadog],
    },
  ]) {
    assert.equal(fixtureBinding(project, changed), null);
    assert.equal(qualificationInput(project, changed, "cloudflare"), null);
  }
});

test("only application-confirmed approved reads qualify", () => {
  assert.equal(
    verifiedRead("cloudflare", {
      phase: "call",
      server: "cloudflare",
      status: "ok",
      apiSuccess: true,
      apiStatus: 200,
      count: 1,
    }),
    true,
  );
  assert.equal(
    verifiedRead("cloudflare", {
      phase: "call",
      server: "cloudflare",
      status: "ok",
      apiSuccess: true,
      apiStatus: 200,
      count: 0,
    }),
    false,
  );
  assert.equal(
    verifiedRead("datadog", {
      phase: "call",
      server: "datadog",
      status: "ok",
      application: { outcome: "success" },
    }),
    true,
  );
  assert.equal(
    verifiedRead("datadog", {
      phase: "call",
      server: "datadog",
      status: "ok",
      application: { outcome: "truncated" },
    }),
    false,
  );
  assert.equal(
    verifiedRead("cloudflare", {
      phase: "call",
      server: "posthog",
      status: "ok",
      apiSuccess: true,
      apiStatus: 200,
      count: 1,
    }),
    false,
  );
});

test("guest identity and sanitized read outcome reuse IAP guard without exposing metadata", () => {
  const metadata = {
    PI_ORB_ID: orbId,
    PI_ORB_RUNTIME_TOKEN: "secret",
    PI_ORB_CONTROL_PLANE_URL: "https://control.example",
  };
  assert.equal(identity(metadata, orbId), true);
  assert.equal(identity(metadata, "not-uuid"), false);
  assert.equal(identity({ ...metadata, PI_ORB_ID: "other" }, orbId), false);
  assert.deepEqual(
    sanitize({
      phase: "call",
      server: "datadog",
      status: "ok",
      excerpt: "secret",
      application: { outcome: "success", resultCount: 0 },
    }),
    {
      phase: "read",
      server: "datadog",
      status: "ok",
      application: { outcome: "success", resultCount: 0 },
    },
  );
});
