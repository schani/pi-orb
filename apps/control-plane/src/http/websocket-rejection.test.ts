import { once } from "node:events";
import { Socket } from "node:net";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { registerWebSocketRejectionCleanup } from "./websocket-rejection.ts";

function readResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const onData = (chunk: Buffer) => {
      raw += chunk.toString();
      const boundary = raw.indexOf("\r\n\r\n");
      const length = /\r\ncontent-length: (\d+)/i.exec(raw)?.[1];
      if (boundary < 0 || length === undefined || raw.length - boundary - 4 < Number(length))
        return;
      socket.off("data", onData);
      socket.off("error", reject);
      resolve(raw);
    };
    socket.on("error", reject);
    socket.on("data", onData);
  });
}

it.each([401, 403, 302])(
  "closes an upgrade rejected before WebSocket hooks with %s",
  async (status) => {
    const app = Fastify();
    registerWebSocketRejectionCleanup(app);
    app.addHook("onRequest", async (_request, reply) => {
      reply.code(status).send("rejected");
    });
    await app.register(websocket);
    app.get("/live", { websocket: true }, (socket) => socket.close());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    const accepted = once(app.server, "connection");
    const client = new Socket();
    let peer: Socket | undefined;
    try {
      client.connect(address.port, "127.0.0.1");
      [peer] = (await accepted) as [Socket];
      const peerTerminal = Promise.race([once(peer, "end"), once(peer, "close")]);
      const response = readResponse(client);
      client.write(
        "GET /live HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive, Upgrade\r\n" +
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
      const raw = await response;
      expect(raw).toContain(`HTTP/1.1 ${status}`);
      expect(raw).toMatch(/\r\n\r\nrejected$/);
      client.destroy();
      await peerTerminal;
      expect(peer.destroyed || peer.writableEnded).toBe(true);
      expect(app.websocketServer.clients.size).toBe(0);
    } finally {
      client.destroy();
      peer?.destroy();
      await app.close();
    }
  },
);

it("preserves accepted WebSockets and ordinary HTTP keep-alive", async () => {
  const app = Fastify();
  registerWebSocketRejectionCleanup(app);
  await app.register(websocket);
  app.get("/live", { websocket: true }, (socket) => {
    socket.on("message", (message) => socket.send(message));
  });
  app.get("/health", async () => "ok");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/live`);
  const http = new Socket();
  try {
    await once(client, "open");
    const message = once(client, "message");
    client.send("hello");
    expect((await message)[0].toString()).toBe("hello");
    const closed = once(client, "close");
    client.close();
    await closed;
    http.connect(address.port, "127.0.0.1");
    await once(http, "connect");
    for (let request = 0; request < 2; request++) {
      const response = readResponse(http);
      http.write("GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
      expect(await response).toContain("\r\n\r\nok");
    }
  } finally {
    client.terminate();
    http.destroy();
    await app.close();
  }
});
