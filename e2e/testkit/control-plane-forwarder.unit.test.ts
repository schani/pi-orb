import { createServer } from "node:http";
import { connect } from "node:net";
import { expect, it } from "vitest";
import { createControlPlaneForwarder } from "./control-plane-forwarder.ts";

it("retains its public listener before child startup and forwards exact Host and upgrade bytes", async () => {
  const child = createServer((request, response) => response.end(request.headers.host));
  child.on("upgrade", (request, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
    );
    socket.write(request.headers.host + ":" + head.toString());
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => child.listen(0, "127.0.0.1", resolve));
  const address = child.address();
  if (!address || typeof address === "string") throw new Error("missing child");
  const ingress = await createControlPlaneForwarder(0, "127.0.0.1");
  const sockets = [];
  try {
    const socket = connect(ingress.port, "127.0.0.1");
    sockets.push(socket);
    let received = "";
    const complete = new Promise<string>((resolve, reject) => {
      socket.on("data", (chunk) => {
        received += chunk;
        if (received.endsWith("app.test:beforeafter")) resolve(received);
      });
      socket.on("error", reject);
    });
    socket.write(
      "GET /live HTTP/1.1\r\nHost: app.test\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\nbefore",
    );
    ingress.setTarget(address.port);
    // A second write after upgrade proves this is a duplex stream, not just HTTP response forwarding.
    await expect.poll(() => received.includes("101 Switching Protocols")).toBe(true);
    socket.write("after");
    expect(await complete).toContain("app.test:beforeafter");
    expect(await (await fetch(ingress.baseUrl)).text()).toBe(`127.0.0.1:${ingress.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await ingress.close();
    child.closeAllConnections();
    await new Promise<void>((resolve) => child.close(() => resolve()));
  }
});

it("closes connections acquired before a child target exists and releases its listener", async () => {
  const ingress = await createControlPlaneForwarder(0, "127.0.0.1");
  const socket = connect(ingress.port, "127.0.0.1");
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  await ingress.close();
  await closed;
  expect(socket.destroyed).toBe(true);
  await ingress.close();
});
