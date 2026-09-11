import { createServer } from "node:http";
import { NoSimulationTask } from "determined";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { McpCredentialResolver } from "./oauth.ts";
import { HttpMcpTransport } from "./transport.ts";

it("injects tokens on every request and never replays an accepted call after a 401", async () => {
  const task = new NoSimulationTask("oauth-transport", false);
  let writes = 0;
  let generation = 1;
  let brokerCalls = 0;
  const authorizations: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    authorizations.push(req.headers.authorization ?? "");
    let raw = "";
    for await (const part of req) raw += part;
    const message = JSON.parse(raw);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === "tools/call") {
      writes++;
      res.writeHead(401).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : { tools: [{ name: "write", inputSchema: { type: "object" } }] };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture not listening");
  const credentials = new McpCredentialResolver({
    request: async (_task, _signal, rejected) => {
      brokerCalls++;
      if (rejected === generation) generation++;
      return ok({
        accessToken: `token-${generation}`,
        generation,
        expiresAt: task.wallNow() + 3_600_000,
      });
    },
  });
  const transport = new HttpMcpTransport(`http://127.0.0.1:${address.port}/mcp`, {}, credentials);
  const signal = new AbortController().signal;
  const session = (await transport.connect(task, signal))._unsafeUnwrap();
  try {
    const first = await session.perform(
      task,
      { method: "tools/call", name: "write", arguments: {} },
      signal,
    );
    expect(first.isErr()).toBe(true);
    expect(writes).toBe(1);
    expect(brokerCalls).toBe(1);
    expect(authorizations.every((value) => value === "Bearer token-1")).toBe(true);
    await session.perform(task, { method: "tools/call", name: "write", arguments: {} }, signal);
    expect(writes).toBe(2);
    expect(brokerCalls).toBe(2);
    expect(authorizations.at(-1)).toBe("Bearer token-2");
    await session.perform(task, { method: "tools/call", name: "write", arguments: {} }, signal);
    expect(writes).toBe(2); // rejected twice: reconnect required, no third write
  } finally {
    await session.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
