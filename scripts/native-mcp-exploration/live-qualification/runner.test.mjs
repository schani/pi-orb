import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { installOneRejectedReadPost } from "./fault.mjs";
import { dedicatedCatalog, referencedSecrets, runQualification } from "./runner.ts";

test("dedicated catalog fence accepts only the two exact grant bindings", () => {
  const servers = [
    {
      name: "cloudflare",
      url: "https://mcp.cloudflare.com/mcp",
      oauth: { id: "075be044-30ad-4933-b6fc-d7a55b9816a1" },
      headers: {},
    },
    {
      name: "datadog",
      url: "https://mcp.us5.datadoghq.com/v1/mcp",
      oauth: { id: "7f3e3961-a70f-4b57-8de3-24a642f56005" },
      headers: {},
    },
  ];
  assert.equal(dedicatedCatalog({ revision: 1, servers }), true);
  for (const catalog of [
    { revision: 3, servers },
    { revision: 1, servers: [...servers, { name: "posthog" }] },
    { revision: 1, servers: [servers[0], { ...servers[1], oauth: { id: "wrong" } }] },
    {
      revision: 1,
      servers: [servers[0], { ...servers[1], headers: { Authorization: { literal: "oops" } } }],
    },
  ])
    assert.equal(dedicatedCatalog(catalog), false);
});

test("one-shot fault only changes exact MCP tool POST after grant and restores fetch", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: new Headers(init.headers).get("Authorization") });
    return new Response("", { status: 401 });
  };
  const prior = globalThis.fetch;
  const url = "https://mcp.cloudflare.com/mcp";
  const request = {
    method: "POST",
    headers: { Authorization: "Bearer real-grant" },
    body: JSON.stringify({ method: "tools/call" }),
  };
  try {
    const fault = installOneRejectedReadPost(url);
    await fetch(url, request); // connection creation can capture fetch before grant: no injection
    await fetch("https://control.example/runtime/v1/mcp/id/token", request);
    await fetch(url, { ...request, body: JSON.stringify({ method: "tools/list" }) });
    fault.arm();
    await fetch(url, request);
    await fetch(url, request);
    assert.deepEqual(fault.evidence(), { injected: 1, toolPosts: 2, upstreamStatuses: [401, 401] });
    fault.restore();
    assert.deepEqual(
      seen.map((x) => x.authorization),
      [
        "Bearer real-grant",
        "Bearer real-grant",
        "Bearer real-grant",
        "Bearer pi-orb-qualification-invalid",
        "Bearer real-grant",
      ],
    );
    assert.equal(globalThis.fetch, prior);
    const second = installOneRejectedReadPost(url);
    try {
      throw new Error("failure");
    } catch {
      second.restore();
    }
    assert.equal(globalThis.fetch, prior);
  } finally {
    globalThis.fetch = original;
  }
});

test("snapshot projection retains only referenced bindings", () => {
  const catalog = { servers: [{ headers: { Authorization: { secret: "POSTHOG_TOKEN" } } }] };
  const snapshot = { POSTHOG_TOKEN: "fixture-key", OTHER: "must-not-leak" };
  const selected = referencedSecrets(catalog, snapshot);
  assert.equal(selected.isOk(), true);
  assert.deepEqual(selected.value, { POSTHOG_TOKEN: "fixture-key" });
  assert.equal(JSON.stringify(selected.value).includes(snapshot.OTHER), false);
  const missing = referencedSecrets(catalog, { OTHER: "must-not-leak" });
  assert.equal(missing.isErr(), true);
  assert.deepEqual(missing.error, { phase: "binding", code: "secret_unavailable" });
});

test("actual Pi 1.0.0 session binds production native adapter, discovers, calls and shuts down", {
  timeout: 15000,
}, async () => {
  const methods = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") return void res.writeHead(405).end();
    if (req.method === "DELETE") return void res.writeHead(204).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    methods.push(request.method);
    if (request.method === "tools/call") {
      assert.equal(req.headers["x-static"], "fixture-only");
      assert.equal(request.params.name, "get_count");
      assert.deepEqual(request.params.arguments, { limit: 2 });
    }
    if (!Object.hasOwn(request, "id")) return void res.writeHead(202).end();
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : request.method === "tools/list"
          ? {
              tools: [
                {
                  name: "get_count",
                  description: "fixture read",
                  inputSchema: {
                    type: "object",
                    properties: { limit: { type: "integer", maximum: 10 } },
                  },
                },
              ],
            }
          : { content: [{ type: "text", text: "SENSITIVE_FIXTURE_PAYLOAD" }] };
    res
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const events = [];
  try {
    const outcome = await runQualification({
      catalog: {
        revision: 3,
        servers: [
          {
            name: "fixture",
            description: "fixture read",
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            headers: { "X-Static": { secret: "FIXTURE_KEY" } },
          },
        ],
      },
      broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "fixture-only" },
      secrets: { FIXTURE_KEY: "fixture-only" },
      phase: "call",
      serverName: "fixture",
      toolName: "get_count",
      argument: '{"limit":2}',
      exactReviewed: { fixture: { get_count: { limit: 2 } } },
      output: (item) => events.push(item),
    });
    assert.equal(outcome.isOk(), true);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("tools/list"));
    assert.ok(methods.includes("tools/call"));
    assert.deepEqual(
      events.find((item) => item.phase === "call") &&
        Object.keys(events.find((item) => item.phase === "call")).sort(),
      ["contentCount", "durationMs", "phase", "server", "status", "tool"],
    );
    assert.equal(events.find((item) => item.phase === "call").status, "ok");
    assert.equal(JSON.stringify(events).includes("SENSITIVE_FIXTURE_PAYLOAD"), false);
    for (const [toolName, argument] of [
      ["get_count", '{"limit":3}'],
      ["get_count", '{"limit":2,"extra":1}'],
      ["other", '{"limit":2}'],
      ["get_count", "not-json"],
    ]) {
      const before = methods.filter((method) => method === "tools/call").length;
      const denied = await runQualification({
        catalog: {
          revision: 3,
          servers: [
            {
              name: "fixture",
              description: "fixture read",
              url: `http://127.0.0.1:${server.address().port}/mcp`,
              headers: { "X-Static": { secret: "FIXTURE_KEY" } },
            },
          ],
        },
        broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "fixture-only" },
        secrets: { FIXTURE_KEY: "fixture-only" },
        phase: "call",
        serverName: "fixture",
        toolName,
        argument,
        exactReviewed: { fixture: { get_count: { limit: 2 } } },
        output: (item) => events.push(item),
      });
      assert.equal(denied.isErr(), true);
      assert.equal(denied.error.phase, "guard");
      assert.equal(methods.filter((method) => method === "tools/call").length, before);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public native reconnect command reopens the same Pi session before reviewed read", {
  timeout: 15000,
}, async () => {
  let initialize = 0;
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") return void res.writeHead(405).end();
    if (req.method === "DELETE") return void res.writeHead(204).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.method === "initialize") initialize++;
    if (request.method === "tools/call") calls++;
    if (!Object.hasOwn(request, "id")) return void res.writeHead(202).end();
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : request.method === "tools/list"
          ? { tools: [{ name: "read", inputSchema: { type: "object", properties: {} } }] }
          : { content: [{ type: "text", text: "private-result" }] };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const output = [];
  try {
    const outcome = await runQualification({
      catalog: {
        revision: 1,
        servers: [
          {
            name: "fixture",
            description: "read",
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            headers: {},
          },
        ],
      },
      broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "fixture" },
      secrets: {},
      phase: "reconnect",
      serverName: "fixture",
      toolName: "read",
      argument: "{}",
      exactReviewed: { fixture: { read: {} } },
      output: (record) => output.push(record),
    });
    assert.equal(outcome.isOk(), true);
    assert.equal(initialize, 2);
    assert.equal(calls, 1);
    assert.equal(output.find((event) => event.phase === "reconnect")?.sessionPreserved, true);
    assert.equal(JSON.stringify(output).includes("private-result"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("selected metadata inspection is bounded to requested tools", { timeout: 15000 }, async () => {
  const server = createServer(async (req, res) => {
    if (req.method === "GET") return void res.writeHead(405).end();
    if (req.method === "DELETE") return void res.writeHead(204).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (!Object.hasOwn(request, "id")) return void res.writeHead(202).end();
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : {
            tools: [
              {
                name: "selected",
                description: "safe read",
                inputSchema: { type: "object", properties: {} },
              },
              {
                name: "ignored",
                description: "IGNORED_PRIVATE_DESCRIPTION",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const events = [];
  try {
    await runQualification({
      catalog: {
        revision: 3,
        servers: [
          {
            name: "fixture",
            description: "fixture",
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            headers: {},
          },
        ],
      },
      broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "fixture-only" },
      secrets: {},
      phase: "inspect",
      serverName: "fixture",
      toolName: "selected",
      output: (item) => events.push(item),
    });
    assert.deepEqual(
      events.filter((item) => item.phase === "inspect").map((item) => item.tool),
      ["selected"],
    );
    assert.equal(events.find((item) => item.phase === "inspect").description, "safe read");
    assert.equal(JSON.stringify(events).includes("IGNORED_PRIVATE_DESCRIPTION"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("empty native discovery is a connection failure, not a healthy zero-tool result", {
  timeout: 15000,
}, async () => {
  const server = createServer((_req, res) => res.writeHead(503).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const events = [];
  try {
    const outcome = await runQualification({
      catalog: {
        revision: 3,
        servers: [
          {
            name: "fixture",
            description: "fixture",
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            headers: {},
          },
        ],
      },
      broker: { controlPlaneUrl: "http://127.0.0.1", runtimeToken: "fixture-only" },
      secrets: {},
      phase: "discover",
      output: (item) => events.push(item),
    });
    assert.equal(outcome.isErr(), true);
    assert.deepEqual(outcome.error, { phase: "connection", code: "discovery_failed" });
    assert.equal(
      events.some(
        (item) => item.phase === "discover" && item.server === "fixture" && item.count === 0,
      ),
      false,
    );
    assert.equal(
      events.some((item) => item.phase === "connection_failure" && item.server === "fixture"),
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
