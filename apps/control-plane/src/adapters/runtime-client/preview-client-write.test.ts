import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { wrapPreviewSocket } from "./preview-client.ts";

it("treats a native successful binary WebSocket write as success", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const accepted = once(sockets, "connection");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned WS listener missing");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    const [upstream] = (await accepted) as [WebSocket];
    await once(client, "open");
    const received = once(upstream, "message");
    const adapter = wrapPreviewSocket(client);
    const sent = await adapter.write({ bytes: new Uint8Array([0, 255]), binary: true });
    const [bytes, binary] = await received;
    expect(bytes).toEqual(Buffer.from([0, 255]));
    expect(binary).toBe(true);
    expect(sent.isOk()).toBe(true);
  } finally {
    client.terminate();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
