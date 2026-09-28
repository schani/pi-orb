import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { startInferenceTrace } from "./inference-trace.ts";

it("distinguishes remote EOF after a nonterminal SSE event from client cancellation", async () => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.created","response":{"id":"secret"}}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream");
  const trace = await startInferenceTrace(`http://127.0.0.1:${address.port}/oai/test`);
  try {
    const response = await fetch(`${trace.baseUrl}/backend-api/codex/responses`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(trace.records).toMatchObject([
      {
        upstreamStatus: 200,
        eventTypes: ["response.created"],
        outcome: "upstream_eof",
        route: "responses",
      },
    ]);
    expect(JSON.stringify(trace.records)).not.toContain("secret");
  } finally {
    await trace.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("forwards GET without a body", async () => {
  const upstream = createServer((req, res) => res.end(req.method));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream");
  const trace = await startInferenceTrace(`http://127.0.0.1:${address.port}/oai/test`);
  try {
    const response = await fetch(`${trace.baseUrl}/backend-api/codex/responses`);
    expect(await response.text()).toBe("GET");
    expect(trace.records[0]).toMatchObject({ method: "GET", upstreamStatus: 200 });
  } finally {
    await trace.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("cuts the isolated model stream after response.created exactly once", async () => {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream");
  const trace = await startInferenceTrace(`http://127.0.0.1:${address.port}/oai/test`, {
    cutIsolationOnce: true,
  });
  try {
    const first = await fetch(`${trace.baseUrl}/backend-api/codex/responses`, {
      method: "POST",
      body: zstdCompressSync(`${"repeatable input ".repeat(1000)} MCP isolation`),
      headers: { "content-encoding": "zstd" },
    });
    expect(await first.text()).toContain("response.created");
    const second = await fetch(`${trace.baseUrl}/backend-api/codex/responses`, {
      method: "POST",
      body: '"MCP isolation"',
    });
    expect(await second.text()).toContain("response.completed");
    expect(trace.records.map((record) => record.outcome)).toEqual([
      "injected_cutoff",
      "upstream_eof",
    ]);
  } finally {
    await trace.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
