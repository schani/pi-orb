import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const staged = process.env.STAGED_INITIAL_AUTH;
const stage = staged && resolve(staged);
if (stage) {
  const sdk = realpathSync(
    join(stage, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
  );
  assert.ok(sdk.startsWith(realpathSync(stage) + sep), `SDK escaped stage: ${sdk}`);
  assert.equal(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "process.stdout.write(import.meta.resolve('@earendil-works/pi-coding-agent'))",
      ],
      { cwd: stage, encoding: "utf8" },
    ),
    pathToFileURL(sdk).href,
  );
}
const { runInitialAuth } = await import(
  stage ? pathToFileURL(join(stage, "initial-auth.mjs")).href : "./initial-auth.ts"
);

const cf = {
  code: "async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts', query: { per_page: 1 } }); return { success: r.success, status: r.status, count: Array.isArray(r.result) ? r.result.length : 0 }; }",
};
const dd = {
  max_tokens: 1000,
  query: "status:alert priority:p1",
  telemetry: { intent: "Qualify native MCP read-only monitor search" },
};

test("initial broker auth_required yields zero tools; only next before_agent_start in same session recovers and executes reviewed reads", {
  timeout: 20000,
}, async () => {
  let authorized = false;
  let initialized = 0;
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/runtime/v1/mcp/")) {
      if (!authorized)
        return void res
          .writeHead(401, { "content-type": "application/json" })
          .end(
            JSON.stringify({ error: { code: "auth_required", message: "authorization required" } }),
          );
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({ accessToken: "fixture", expiresAt: Date.now() + 60000, generation: 1 }),
        );
    }
    if (req.method === "GET") return void res.writeHead(405).end();
    if (req.method === "DELETE") return void res.writeHead(204).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.method === "initialize") initialized++;
    if (request.method === "tools/call")
      calls.push({ name: request.params.name, arguments: request.params.arguments });
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
                  name: req.url === "/cloudflare" ? "execute" : "search_datadog_monitors",
                  inputSchema: {
                    type: "object",
                    properties:
                      req.url === "/cloudflare"
                        ? { code: {} }
                        : { max_tokens: {}, query: {}, telemetry: {} },
                  },
                },
              ],
            }
          : {
              content: [
                {
                  type: "text",
                  text:
                    req.url === "/cloudflare"
                      ? JSON.stringify({ success: true, status: 200, count: 1 })
                      : "<JSON_DATA></JSON_DATA><message>No monitors found</message>",
                },
              ],
            };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const records = [];
  let gateReached = false;
  try {
    const outcome = await runInitialAuth({
      catalog: {
        revision: 1,
        servers: [
          { name: "cloudflare", url: `${url}/cloudflare`, oauth: { id: "cf" }, headers: {} },
          { name: "datadog", url: `${url}/datadog`, oauth: { id: "dd" }, headers: {} },
        ],
      },
      broker: { controlPlaneUrl: url, runtimeToken: "fixture" },
      secrets: {},
      waitForResume: async () => {
        gateReached = true;
        assert.equal(initialized, 0);
        assert.equal(calls.length, 0);
        authorized = true;
      },
      output: (record) => records.push(record),
    });
    assert.equal(outcome.isOk(), true);
    assert.equal(gateReached, true);
    assert.equal(initialized, 2);
    assert.deepEqual(calls, [
      { name: "execute", arguments: cf },
      { name: "search_datadog_monitors", arguments: dd },
    ]);
    assert.equal(records.filter((r) => r.phase === "initial_auth").length, 2);
    assert.deepEqual(
      records.filter((r) => r.phase === "read").map((r) => r.server),
      ["cloudflare", "datadog"],
    );
    assert.equal(new Set(records.filter((r) => r.sessionId).map((r) => r.sessionId)).size, 1);
    assert.equal(JSON.stringify(records).includes("accessToken"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
