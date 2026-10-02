import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { connect, isIP, Socket } from "node:net";
import { Agent } from "undici";

function fixtureIp(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c, d] = value.split(".").map(Number);
  return a === 10 && b === 10 && c < 16 && !(c === 0 && d === 0) && !(c === 15 && d === 255);
}

export function fixtureTarget(f, host, port) {
  if (Number(port) !== 8080 || !fixtureIp(host) || !f.connectionMap) return null;
  try {
    const stat = statSync(f.connectionMap);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    const map = JSON.parse(readFileSync(f.connectionMap, "utf8"));
    if (
      map.orbId !== f.orbId ||
      map.projectId !== f.projectId ||
      map.connectionNonce !== f.connectionNonce ||
      !fixtureIp(map.privateIp) ||
      map.privateIp !== host ||
      Object.keys(map).sort().join() !== "connectionNonce,orbId,privateIp,projectId"
    )
      return null;
    return "127.0.0.1";
  } catch {
    return null;
  } // Missing or partial map: no rewrite.
}

export function installFixtureTransport(f, { forwardPort = 18880 } = {}) {
  assert.equal(forwardPort > 0 && forwardPort <= 65535, true);
  const original = Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const dispatcher = new Agent({
    connect: (_options, callback) => {
      const socket = connect({ host: "127.0.0.1", port: forwardPort });
      const onConnect = () => {
        socket.off("error", onError);
        callback(null, socket);
      };
      const onError = (error) => {
        socket.off("connect", onConnect);
        callback(error, null);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    },
  });
  let announced = false;
  const announce = () => {
    if (announced) return;
    console.error("native-browser: owned runtime transport mapped to SSH forward");
    announced = true;
  };
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "http:" || !fixtureTarget(f, url.hostname, Number(url.port || 80)))
      return originalFetch(input, init);
    announce();
    return originalFetch(input, { ...init, dispatcher });
  };
  Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]);
    const options = normalized ? args[0][0] : args[0];
    if (
      options &&
      typeof options === "object" &&
      !Array.isArray(options) &&
      fixtureTarget(f, options.host ?? options.hostname, options.port)
    ) {
      announce();
      const mapped = { ...options, host: "127.0.0.1", hostname: "127.0.0.1", port: forwardPort };
      if (normalized) args[0][0] = mapped;
      else args[0] = mapped;
    }
    return original.apply(this, args);
  };
  return () => {
    Socket.prototype.connect = original;
    globalThis.fetch = originalFetch;
    void dispatcher.close();
  };
}
