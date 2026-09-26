import { createServer } from "node:http";
import { connect, type Socket } from "node:net";

/** Browser DNS seam: exact owned CONNECT authorities, loopback only, no ordinary proxy traffic. */
export async function startAuthConnectProxy(targets: ReadonlyMap<string, number>) {
  const allowed = new Map(targets);
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((_request, response) => {
    response.writeHead(403, { Connection: "close" });
    response.end();
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    const port = allowed.get(request.url ?? "");
    if (port === undefined) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = track(connect({ host: "127.0.0.1", port }));
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
