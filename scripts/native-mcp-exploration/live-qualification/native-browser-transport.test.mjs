import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { fixtureTarget, installFixtureTransport } from "./native-browser-transport.mjs";

const fixture = {
  orbId: "11111111-2222-4333-8444-555555555555",
  projectId: "77777777-2222-4333-8444-555555555555",
  connectionNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
};
const ip = "10.10.0.9";

function writeMap(path, mapping) {
  writeFileSync(`${path}.tmp`, JSON.stringify(mapping), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

test("only attested fixture IP:8080 uses tunnel; HTTP/WS retain original Host and Origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-browser-"));
  const path = join(directory, "connection.json");
  const server = createServer((req, res) => {
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin }));
  });
  const wsServer = new WebSocketServer({ server });
  let upgrade;
  wsServer.on("connection", (socket, req) => {
    upgrade = { host: req.headers.host, origin: req.headers.origin };
    socket.send("ready");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const original = Socket.prototype.connect;
  try {
    // Before a verified map exists, no fixture connection is rewritten.
    const restore = installFixtureTransport(
      { ...fixture, connectionMap: path },
      { forwardPort: port },
    );
    assert.equal(Socket.prototype.connect === original, false);
    writeMap(path, { ...fixture, privateIp: ip });
    assert.equal(fixtureTarget({ ...fixture, connectionMap: path }, ip, 8080), "127.0.0.1");
    const response = await fetch(`http://${ip}:8080/probe`, {
      headers: { Origin: "http://browser.example" },
    });
    assert.deepEqual(await response.json(), {
      host: `${ip}:8080`,
      origin: "http://browser.example",
    });
    const ws = new WebSocket(`ws://${ip}:8080/socket`, { origin: "http://browser.example" });
    const messagePromise = once(ws, "message");
    await once(ws, "open");
    const [message] = await messagePromise;
    assert.equal(message.toString(), "ready");
    assert.deepEqual(upgrade, { host: `${ip}:8080`, origin: "http://browser.example" });
    ws.close();
    await once(ws, "close");
    // Wrong nonce and unrelated destination must never be rewritten.
    writeMap(path, { ...fixture, connectionNonce: "wrong", privateIp: ip });
    assert.equal(fixtureTarget({ ...fixture, connectionMap: path }, ip, 8080), null);
    assert.equal(fixtureTarget({ ...fixture, connectionMap: path }, "10.10.0.8", 8080), null);
    assert.equal(fixtureTarget({ ...fixture, connectionMap: path }, "8.8.8.8", 8080), null);
    const direct = await fetch(`http://127.0.0.1:${port}/direct`);
    assert.equal((await direct.json()).host, `127.0.0.1:${port}`);
    const untouched = new Socket();
    untouched.on("error", () => {});
    untouched.connect({ host: "127.0.0.1", port });
    await once(untouched, "connect");
    untouched.destroy();
    restore();
    assert.equal(Socket.prototype.connect, original);
  } finally {
    Socket.prototype.connect = original;
    wsServer.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
