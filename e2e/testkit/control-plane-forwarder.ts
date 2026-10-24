import { connect, createServer, type Socket } from "node:net";

/** Own the advertised endpoint while the child independently binds its internal port. */
export async function createControlPlaneForwarder(port: number, host: string) {
  const sockets = new Set<Socket>();
  const pending = new Set<Socket>();
  let target: number | undefined;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      pending.delete(socket);
    });
    return socket;
  };
  const forward = (client: Socket) => {
    pending.delete(client);
    if (client.destroyed || target === undefined) return;
    const upstream = track(connect({ host: "127.0.0.1", port: target }));
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    upstream.once("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
  };
  const server = createServer({ pauseOnConnect: true }, (client) => {
    track(client);
    client.on("error", () => client.destroy());
    if (target === undefined) pending.add(client);
    else forward(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing owned control-plane ingress");
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    setTarget(port: number) {
      target = port;
      for (const socket of pending) forward(socket);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
