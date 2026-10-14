import { createServer, request } from "node:http";
import type { Socket } from "node:net";

/** Own the public random port before configuring app origin; the child also binds port 0. */
export async function ownedControlPlaneIngress() {
  let target: string | undefined;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer((incoming, outgoing) => {
    if (!target) return void outgoing.writeHead(503).end();
    const upstream = request(
      new URL(incoming.url ?? "/", target),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", track);
  server.on("upgrade", (incoming, client, head) => {
    if (!target) return void client.destroy();
    const upstream = request(new URL(incoming.url ?? "/", target), {
      method: incoming.method,
      headers: incoming.headers,
    });
    upstream.on("error", () => client.destroy());
    upstream.on("response", () => client.destroy());
    upstream.on("upgrade", (response, remote, remoteHead) => {
      track(remote);
      client.on("error", () => remote.destroy());
      remote.on("error", () => client.destroy());
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let index = 0; index < response.rawHeaders.length; index += 2)
        client.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
      client.write("\r\n");
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing ingress listener");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    connect: (url: string) => {
      target = url;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
