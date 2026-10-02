import { once } from "node:events";
import http from "node:http";

export async function startNativeMcpFixture({ gate, note }) {
  const calls = [];
  const sockets = new Set();
  let nextSession = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const method = message?.method ?? req.method;
    calls.push({ method, session: req.headers["mcp-session-id"] });
    if (req.method === "GET") return void res.writeHead(405).end();
    if (req.method === "DELETE") return void res.writeHead(204).end();
    if (method === "tools/call") {
      res.once("close", () => {
        if (!res.writableEnded) note("tool:one:abort-observed");
      });
      note("tool:one:entered");
      await gate.promise;
      note("tool:one:exited");
    }
    if (!message || !("id" in message)) return void res.writeHead(202).end();
    const result =
      method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "probe", version: "1" },
            capabilities: { tools: {} },
          }
        : method === "tools/list"
          ? { tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] }
          : method === "tools/call"
            ? { content: [{ type: "text", text: "done" }] }
            : {};
    res
      .writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id":
          method === "initialize"
            ? `native-${++nextSession}`
            : (req.headers["mcp-session-id"] ?? "native-unknown"),
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
