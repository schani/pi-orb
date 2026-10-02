import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpClient } from "@earendil-works/pi-mcp";
import { ok } from "neverthrow";
import { McpCredentialResolver } from "../../apps/orb-runtime/src/mcp/oauth.ts";
import { piOwnedTransport } from "./broker-transport.mjs";
import { createNativeAuthRetryTransport } from "./native-auth-retry.mjs";
import { startFixture } from "./transport-fixture.mjs";

async function connected(t, { native = true, repeat = false } = {}) {
  const fixture = await startFixture();
  const directory = await mkdtemp(join(tmpdir(), "native-auth-retry-"));
  const authPath = join(directory, "auth.json");
  let generation = 0;
  const requests = [];
  const rejected = [];
  const checkpoints = [];
  const task = {
    wallNow: () => 1000,
    checkpoint: async (name) => {
      checkpoints.push(name);
    },
  };
  const resolver = new McpCredentialResolver({
    request: async (_task, signal, rejectedGeneration) => {
      assert.equal(signal.aborted, false);
      requests.push(rejectedGeneration);
      return ok({ accessToken: `token-${++generation}`, generation, expiresAt: 100_000 });
    },
  });
  const broker = {
    resolve: (signal) => resolver.resolve(task, signal),
    rejected: (generation) => {
      rejected.push(generation);
      resolver.rejected(generation);
      if (repeat) fixture.rejectOnce = 401;
    },
    accepted: () => resolver.accepted(),
  };
  const Transport = await piOwnedTransport();
  const transport = createNativeAuthRetryTransport({ url: fixture.url, broker, Transport, native });
  const client = new McpClient({ name: "retry-proof", version: "1" });
  t.after(async () => {
    await client.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  return { fixture, client, requests, rejected, checkpoints, authPath };
}

const calls = (fixture) => fixture.calls.filter((call) => call.method === "tools/call");

test("without native auth callback a 401 rejects, never replays", async (t) => {
  const { fixture, client } = await connected(t, { native: false });
  fixture.rejectOnce = 401;
  await assert.rejects(client.callTool("write"));
  assert.equal(calls(fixture).length, 1);
  assert.equal(fixture.accepted, 0);
});

test("native auth callback replays same POST once with broker's newer generation", async (t) => {
  const { fixture, client, requests, rejected, checkpoints, authPath } = await connected(t);
  fixture.rejectOnce = 401;
  await client.callTool("write");
  assert.deepEqual(
    calls(fixture).map((call) => call.token),
    ["token-1", "token-2"],
  );
  assert.deepEqual(requests, [undefined, 1]);
  assert.deepEqual(rejected, [1]);
  assert.equal(calls(fixture).length, 2);
  assert.equal(fixture.accepted, 1);
  assert.ok(checkpoints.every((name) => name === "mcp:credential-resolution"));
  await assert.rejects(readFile(authPath), { code: "ENOENT" });
});

test("a second 401 is bounded at two POST attempts; no guest consent or local token file", async (t) => {
  const { fixture, client, requests, rejected, authPath } = await connected(t, { repeat: true });
  fixture.rejectOnce = 401;
  await assert.rejects(client.callTool("write"));
  assert.deepEqual(
    calls(fixture).map((call) => call.token),
    ["token-1", "token-2"],
  );
  assert.deepEqual(requests, [undefined, 1]);
  assert.deepEqual(rejected, [1, 2]);
  assert.equal(fixture.accepted, 0);
  await assert.rejects(readFile(authPath), { code: "ENOENT" });
});

async function scopeFixture(t, challenged) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    if (message.method === "tools/call") {
      calls.push(req.headers.authorization);
      res
        .writeHead(403, {
          "content-type": "text/plain",
          ...(challenged
            ? { "www-authenticate": 'Bearer error="insufficient_scope", scope="sentinel-scope"' }
            : {}),
        })
        .end("SECRET_RESPONSE_BODY");
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "scope", version: "1" },
            capabilities: { tools: {} },
          }
        : { tools: [{ name: "write", inputSchema: { type: "object", properties: {} } }] };
    res
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "scope-session" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls };
}

for (const challenged of [true, false]) {
  test(`403 ${challenged ? "insufficient_scope challenge" : "without challenge"} follows native retry policy`, async (t) => {
    const fixture = await scopeFixture(t, challenged);
    const Transport = await piOwnedTransport();
    const resolver = new McpCredentialResolver({
      request: async () => ok({ accessToken: "token-1", generation: 1, expiresAt: 100_000 }),
    });
    const task = { wallNow: () => 1000, checkpoint: async () => {} };
    const broker = { resolve: (signal) => resolver.resolve(task, signal) };
    const transport = createNativeAuthRetryTransport({ url: fixture.url, broker, Transport });
    const client = new McpClient({ name: "scope-proof", version: "1" });
    t.after(async () => {
      await client.close();
    });
    await client.connect(transport);
    await assert.rejects(client.callTool("write"), (error) => {
      assert.doesNotMatch(
        String(error) + (error.body ?? ""),
        /SECRET_RESPONSE_BODY|sentinel-scope/,
      );
      return true;
    });
    assert.deepEqual(fixture.calls, Array(challenged ? 2 : 1).fill("Bearer token-1"));
  });
}

test("abort during request-time credential resolution prevents the POST", async (t) => {
  const fixture = await startFixture();
  const Transport = await piOwnedTransport();
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let block = false;
  let observedSignal;
  const resolver = new McpCredentialResolver({
    request: async (_task, signal) => {
      if (block && !observedSignal) {
        observedSignal = signal;
        enter();
        await released;
      }
      return ok({ accessToken: "token-1", generation: 1, expiresAt: 100_000 });
    },
  });
  const task = { wallNow: () => 1000, checkpoint: async () => {} };
  const broker = { resolve: (signal) => resolver.resolve(task, signal) };
  const transport = createNativeAuthRetryTransport({ url: fixture.url, broker, Transport });
  const client = new McpClient({ name: "cancel-proof", version: "1" });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  await client.connect(transport);
  // Force a new resolution rather than the cached grant.
  resolver.rejected(1);
  block = true;
  const pending = client.callTool("write");
  await entered;
  await transport.close();
  assert.equal(observedSignal.aborted, true);
  release();
  await assert.rejects(pending);
  assert.equal(calls(fixture).length, 0);
  assert.equal(fixture.accepted, 0);
});

test("ambiguous lost response after acceptance is never replayed", async (t) => {
  const { fixture, client } = await connected(t);
  fixture.responseLoss = true;
  await assert.rejects(client.callTool("write"));
  assert.equal(calls(fixture).length, 1);
  assert.equal(fixture.accepted, 1);
});
