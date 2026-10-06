import { createServer } from "node:http";
import { zstdCompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { durableFakeRelay } from "./durable-fake-relay.ts";

it("records original compressed requests and bridges raw source and JSON fallback over real HTTP", async () => {
  const bodies: unknown[] = [];
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "codemode" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"code":' },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: JSON.stringify({ code: "text('RAW')" }),
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "codemode",
          arguments: JSON.stringify({ code: "text('RAW')" }),
        },
      },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ];
    for (const event of events)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const relay = await durableFakeRelay(`http://127.0.0.1:${address.port}/backend-api`);
  try {
    const rawBody = {
      tools: [{ type: "custom", name: "codemode" }],
      input: [{ type: "custom_tool_call_output", call_id: "prior", output: "READY" }],
    };
    const raw = await fetch(`${relay.baseUrl}/codex/responses`, {
      method: "POST",
      headers: { "content-encoding": "zstd" },
      body: zstdCompressSync(Buffer.from(JSON.stringify(rawBody))),
    });
    const result = await raw.text();
    expect(result).toContain('"type":"custom_tool_call"');
    expect(result).toContain('"input":"text(\'RAW\')"');
    expect(result).not.toContain("function_call_arguments");
    expect(relay.requests[0]).toEqual(rawBody);
    expect(bodies[0]).toEqual({
      ...rawBody,
      input: [{ ...rawBody.input[0], type: "function_call_output" }],
    });
    const json = await fetch(`${relay.baseUrl}/codex/responses`, {
      method: "POST",
      body: JSON.stringify({ tools: [{ type: "function", name: "codemode" }] }),
    });
    expect(await json.text()).toContain("response.function_call_arguments.delta");
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
