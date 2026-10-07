import { once } from "node:events";
import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";

/** Fixture-only HTTP/WS bridge between loopback TCP and an owned Unix socket. */
export async function startPreviewSocketBridge(socketPath: string, port = 0) {
  const peers = new Set<Socket>();
  const errors: string[] = [];
  const server = createServer((incoming, response) => {
    const upstream = request(
      { socketPath, path: incoming.url, method: incoming.method, headers: incoming.headers },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", (cause) => {
      errors.push(String((cause as NodeJS.ErrnoException).code));
      response.destroy();
    });
    incoming.on("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", (peer) => {
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
  });
  server.on("upgrade", (incoming, downstream, head) => {
    const upstream = connect(socketPath);
    peers.add(upstream);
    upstream.once("close", () => {
      peers.delete(upstream);
      downstream.destroy();
    });
    downstream.once("close", () => upstream.destroy());
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    upstream.once("connect", () => {
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/1.1\r\n${incoming.rawHeaders.reduce((lines, value, index, headers) => (index % 2 === 0 ? `${lines}${value}: ${headers[index + 1]}\r\n` : lines), "")}\r\n`,
      );
      if (head.length) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned socket bridge listener missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    errors,
    close: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
