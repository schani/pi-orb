import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { WebSocketServer } from "ws";

/** Loopback-only application with explicit stream barriers; no platform authentication. */
export async function startPreviewApplication(port = 0) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const streams = new Set<import("node:http").ServerResponse>();
  const binaryStreams = new Set<import("node:http").ServerResponse>();
  let streamOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    streamOpened = resolve;
  });
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const path = request.url ?? "/";
    requests.push({ path, headers: request.headers, body });
    if (path === "/binary") {
      reply.writeHead(200, { "content-type": "application/octet-stream" });
      reply.write(Buffer.from([0, 255, 128]));
      binaryStreams.add(reply);
      reply.once("close", () => binaryStreams.delete(reply));
      return;
    }
    if (path === "/events") {
      reply.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      reply.write("event: ready\ndata: open\n\n");
      streams.add(reply);
      reply.once("close", () => streams.delete(reply));
      streamOpened();
      return;
    }
    if (path === "/upload") {
      reply.writeHead(200, {
        "content-type": "application/octet-stream",
        "set-cookie": [
          "application=kept; Path=/; HttpOnly",
          "__Host-pi-orb-preview=forged; Path=/; Secure; HttpOnly",
          "parent=forged; Domain=preview.test; Path=/",
        ],
        "x-pi-orb-preview-error": "unauthenticated",
        "x-goog-iap-jwt-assertion": "upstream-platform-spoof",
      });
      reply.end(body);
      return;
    }
    if (path === "/redirect") {
      reply.writeHead(302, { location: "./nested?redirected=1" });
      reply.end();
      return;
    }
    if (path.split("?")[0]?.endsWith("/asset.js")) {
      reply.writeHead(200, { "content-type": "text/javascript" });
      reply.end('document.body.dataset.asset = "loaded"');
      return;
    }
    reply.writeHead(200, { "content-type": "text/html" });
    reply.end('<body><p>Loopback preview</p><script src="./asset.js"></script></body>');
  });
  const sockets = new WebSocketServer({ server });
  const frames: { binary: boolean; bytes: Buffer }[] = [];
  let socketOpened!: () => void;
  const socketReady = new Promise<void>((resolve) => {
    socketOpened = resolve;
  });
  sockets.on("connection", (socket) => {
    socketOpened();
    socket.on("message", (bytes, binary) => {
      frames.push({ binary, bytes: Buffer.from(bytes as Buffer) });
      socket.send(bytes, { binary });
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Preview application listener missing");
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    frames,
    socketOpened: socketReady,
    streamOpened: opened,
    finishBinary: () => {
      for (const stream of binaryStreams) stream.end(Buffer.from([13, 10]));
    },
    sendEvent: (data: string) => {
      for (const stream of streams) stream.write(`data: ${data}\n\n`);
    },
    close: async () => {
      for (const stream of streams) stream.destroy();
      for (const stream of binaryStreams) stream.destroy();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
