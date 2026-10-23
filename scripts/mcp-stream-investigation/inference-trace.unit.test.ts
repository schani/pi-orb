import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { startInferenceTrace } from "./inference-trace.ts";

it("records remote EOF after a nonterminal SSE event", async () => {
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
    expect(await response.text()).toBe(
      'data: {"type":"response.created","response":{"id":"secret"}}\n\n',
    );
    expect(trace.records).toEqual([
      {
        method: "POST",
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
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('data: {"type":"response.created"}\n\n');
    const second = await fetch(`${trace.baseUrl}/backend-api/codex/responses`, {
      method: "POST",
      body: '"MCP isolation"',
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(
      'data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n',
    );
    expect(trace.records.map((record) => record.eventTypes)).toEqual([
      ["response.created"],
      ["response.created", "response.completed"],
    ]);
    expect(trace.records.map((record) => record.outcome)).toEqual([
      "injected_cutoff",
      "upstream_eof",
    ]);
  } finally {
    await trace.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it.each([false, true])(
  "classifies client cancellation after terminal=%s without remote EOF",
  async (terminal) => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const event = terminal ? "response.completed" : "response.created";
    const body = `data: {"type":"${event}","private":"secret"}\n\n`;
    const upstream = createServer((_req, res) => {
      res.on("close", closed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(body);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream");
    const trace = await startInferenceTrace(`http://127.0.0.1:${address.port}/oai/test`);
    try {
      const response = await fetch(`${trace.baseUrl}/responses`);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader() ?? expect.fail("missing response reader");
      let bytes = "";
      while (!bytes.endsWith("\n\n")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        bytes += new TextDecoder().decode(chunk.value);
      }
      expect(bytes).toBe(body);
      await reader.cancel();
      await upstreamClosed;
      expect(trace.records).toHaveLength(1);
      expect(trace.records[0]).toMatchObject({
        route: "responses",
        method: "GET",
        upstreamStatus: 200,
        eventTypes: [event],
        outcome: terminal ? "client_close_after_terminal" : "client_close",
      });
      expect(JSON.stringify(trace.records)).not.toContain("secret");
    } finally {
      await trace.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  },
);

it("cuts a created frame split across upstream writes without duplicating its prefix", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prefix = 'data: {"type":"response.';
  const created = `${prefix}created"}\n\n`;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(prefix);
    await released;
    res.end('created"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing upstream");
  const trace = await startInferenceTrace(`http://127.0.0.1:${address.port}/oai/test`, {
    cutIsolationOnce: true,
  });
  try {
    const response = await fetch(`${trace.baseUrl}/responses`, {
      method: "POST",
      body: "MCP isolation",
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader() ?? expect.fail("missing response reader");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(prefix);
    release();
    let body = prefix;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      body += new TextDecoder().decode(next.value);
    }
    expect(body).toBe(created);
    expect(trace.records).toEqual([
      {
        route: "responses",
        method: "POST",
        upstreamStatus: 200,
        eventTypes: ["response.created"],
        outcome: "injected_cutoff",
      },
    ]);
  } finally {
    release();
    await trace.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
