import { request } from "node:http";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { startAuthConnectProxy } from "./auth-connect-proxy.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("tunnels only exact owned authorities and closes admitted sockets", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const authority = `app.owned.test:${address.port}`;
  const proxy = await startAuthConnectProxy(new Map([[authority, address.port]]));
  cleanup.push(proxy.close);
  const connect = (path: string) =>
    new Promise<{ status: number; socket: import("node:stream").Duplex }>((resolve, reject) => {
      const req = request(proxy.url, { method: "CONNECT", path });
      req.once("connect", (response, socket) =>
        resolve({ status: response.statusCode ?? 0, socket }),
      );
      req.once("error", reject);
      req.end();
    });
  for (const path of [
    "evil.test:443",
    "app.owned.test:443",
    `127.0.0.1:${address.port}`,
    `${authority}@evil.test:443`,
  ]) {
    const denied = await connect(path);
    expect(denied.status).toBe(403);
    denied.socket.destroy();
  }
  const admitted = await connect(authority);
  expect(admitted.status).toBe(200);
  const echoed = new Promise<string>((resolve) =>
    admitted.socket.once("data", (chunk) => resolve(String(chunk))),
  );
  admitted.socket.write("owned tunnel");
  expect(await echoed).toBe("owned tunnel");
  const closed = new Promise<void>((resolve) => admitted.socket.once("close", () => resolve()));
  await proxy.close();
  await closed;
});

it("rejects ordinary HTTP requests instead of becoming an egress proxy", async () => {
  const proxy = await startAuthConnectProxy(new Map());
  cleanup.push(proxy.close);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(proxy.url, { path: "http://example.com/" }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once("error", reject);
    req.end();
  });
  expect(status).toBe(403);
});
