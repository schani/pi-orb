import { once } from "node:events";
import http from "node:http";

export async function startFixture() {
  const calls = [];
  const waiters = new Map();
  const fixture = {
    calls,
    accepted: 0,
    redirectHits: 0,
    rejectOnce: 0,
    invalidSessionOnce: false,
    responseLoss: false,
    redirect: false,
  };
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let message;
    if (chunks.length) message = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({
      method: message?.method ?? req.method,
      token: req.headers.authorization?.replace(/^Bearer /, ""),
      static: req.headers["x-static"],
      session: req.headers["mcp-session-id"],
    });
    waiters.get(message?.method ?? req.method)?.();
    waiters.delete(message?.method ?? req.method);
    if (req.url === "/redirect") {
      fixture.redirectHits++;
      res.writeHead(200).end();
      return;
    }
    if (fixture.redirect && message?.method === "tools/call") {
      res.writeHead(302, { location: "/redirect" }).end();
      return;
    }
    if (fixture.invalidSessionOnce && message?.method === "tools/call") {
      fixture.invalidSessionOnce = false;
      res.writeHead(404, { "content-type": "text/plain" }).end("SECRET_BODY");
      return;
    }
    if (fixture.rejectOnce && message?.method === "tools/call") {
      const status = fixture.rejectOnce;
      fixture.rejectOnce = 0;
      res.writeHead(status, { "content-type": "text/plain" }).end("SECRET_BODY");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    if (message?.method === "tools/call") {
      fixture.accepted++;
      if (fixture.responseLoss) {
        req.socket.destroy();
        return;
      }
    }
    if (!("id" in message)) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "loopback", version: "1" },
            capabilities: { tools: {}, resources: {} },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "write", inputSchema: { type: "object", properties: {} } }] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "accepted" }] }
            : message.method === "resources/list"
              ? message.params?.cursor
                ? { resources: [{ uri: "proof://two", name: "two" }] }
                : { resources: [{ uri: "proof://one", name: "one" }], nextCursor: "page-2" }
              : message.method === "resources/templates/list"
                ? { resourceTemplates: [{ uriTemplate: "proof://{id}", name: "template" }] }
                : message.method === "resources/read"
                  ? { contents: [{ uri: message.params.uri, text: "resource" }] }
                  : {};
    res
      .writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fixture.url = `http://127.0.0.1:${server.address().port}/mcp`;
  fixture.waitFor = (method) =>
    calls.some((call) => call.method === method)
      ? Promise.resolve()
      : new Promise((resolve) => waiters.set(method, resolve));
  fixture.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  return fixture;
}
