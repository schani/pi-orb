import { createServer, request } from "node:http";

/** Own the public random port before configuring app origin; the child also binds port 0. */
export async function ownedControlPlaneIngress() {
  let target: string | undefined;
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
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
