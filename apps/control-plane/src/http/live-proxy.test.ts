import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { RUNTIME_SUBPROTOCOL, TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ResultAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { OrbHostProvider } from "../domain/ports.ts";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { registerLiveProxy } from "./live-proxy.ts";

const openServers: Array<{ close: () => Promise<void> }> = [];

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("live proxy", () => {
  it("preserves client.hello sent while asynchronous runtime routing is in progress", async () => {
    const runtime = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has(RUNTIME_SUBPROTOCOL) ? RUNTIME_SUBPROTOCOL : false,
    });
    openServers.push({ close: () => closeWebSocketServer(runtime) });
    await once(runtime, "listening");
    const runtimeAddress = runtime.address() as AddressInfo;
    runtime.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
    });

    let markObserveStarted: () => void = () => undefined;
    const observeStarted = new Promise<void>((resolve) => {
      markObserveStarted = resolve;
    });
    let releaseObserve: () => void = () => undefined;
    const observeGate = new Promise<void>((resolve) => {
      releaseObserve = resolve;
    });

    const harness = makeHarness();
    const orbId = "orb-live-proxy";
    harness.store.seedOrb(makeOrbRow(orbId, "project-a", "running", { hostRef: "host-a" }));
    const delegate = harness.deps.hostProvider;
    const hostProvider: OrbHostProvider = {
      kind: delegate.kind,
      specGeneration: delegate.specGeneration,
      desiredSpecFingerprint: (input) => delegate.desiredSpecFingerprint(input),
      provision: (task, request, context) => delegate.provision(task, request, context),
      start: (task, ref, context) => delegate.start(task, ref, context),
      stop: (task, ref, context) => delegate.stop(task, ref, context),
      discardCompute: (task, request, context) => delegate.discardCompute(task, request, context),
      destroy: (task, id, context) => delegate.destroy(task, id, context),
      listManagedHosts: (task, context) => delegate.listManagedHosts(task, context),
      observe: (_task, ref) => {
        markObserveStarted();
        return ResultAsync.fromSafePromise(observeGate).map(() => ({
          ref,
          orbId,
          incarnation: 0,
          specFingerprint: null,
          state: "running" as const,
          runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
        }));
      },
    };

    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    await registerLiveProxy(app, new NoSimulationTask("live proxy test", false), {
      ...harness.deps,
      hostProvider,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const proxyAddress = app.server.address() as AddressInfo;

    const browser = new WebSocket(
      `ws://127.0.0.1:${proxyAddress.port}/api/v1/orbs/${orbId}/live`,
      RUNTIME_SUBPROTOCOL,
    );
    openServers.push({
      close: async () => {
        browser.terminate();
      },
    });
    await once(browser, "open");
    await observeStarted;

    const reply = once(browser, "message");
    browser.send("client.hello");
    releaseObserve();

    const [data] = await reply;
    expect(data.toString()).toBe("echo:client.hello");
  });

  it("preserves binary terminal traffic in both directions", async () => {
    const runtime = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has(TERMINAL_SUBPROTOCOL) ? TERMINAL_SUBPROTOCOL : false,
    });
    openServers.push({ close: () => closeWebSocketServer(runtime) });
    await once(runtime, "listening");
    const runtimeAddress = runtime.address() as AddressInfo;
    runtime.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });

    const harness = makeHarness();
    const orbId = "orb-terminal-proxy";
    harness.store.seedOrb(makeOrbRow(orbId, "project-a", "running", { hostRef: "host-terminal" }));
    const delegate = harness.deps.hostProvider;
    const hostProvider: OrbHostProvider = {
      kind: delegate.kind,
      specGeneration: delegate.specGeneration,
      desiredSpecFingerprint: (input) => delegate.desiredSpecFingerprint(input),
      provision: (task, request, context) => delegate.provision(task, request, context),
      start: (task, ref, context) => delegate.start(task, ref, context),
      stop: (task, ref, context) => delegate.stop(task, ref, context),
      discardCompute: (task, request, context) => delegate.discardCompute(task, request, context),
      destroy: (task, id, context) => delegate.destroy(task, id, context),
      listManagedHosts: (task, context) => delegate.listManagedHosts(task, context),
      observe: (_task, ref) =>
        ResultAsync.fromSafePromise(Promise.resolve()).map(() => ({
          ref,
          orbId,
          incarnation: 0,
          specFingerprint: null,
          state: "running" as const,
          runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
        })),
    };
    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    await registerLiveProxy(app, new NoSimulationTask("terminal proxy test", false), {
      ...harness.deps,
      hostProvider,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const proxyAddress = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${proxyAddress.port}/api/v1/orbs/${orbId}/terminal`,
      TERMINAL_SUBPROTOCOL,
    );
    openServers.push({ close: async () => browser.terminate() });
    await once(browser, "open");

    const echoed = once(browser, "message");
    browser.send(Buffer.from([0, 1, 2, 255]));
    const [data, isBinary] = await echoed;
    expect(isBinary).toBe(true);
    expect([...Buffer.from(data as Buffer)]).toEqual([0, 1, 2, 255]);

    const closed = once(browser, "close");
    harness.deps.control.closeBrowserConnections(orbId);
    await closed;
  });

  it("consumes presence frames, tracks visibility, and touches last_busy_at on requests", async () => {
    const runtimeReceived: string[] = [];
    const runtime = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) =>
        protocols.has(RUNTIME_SUBPROTOCOL) ? RUNTIME_SUBPROTOCOL : false,
    });
    openServers.push({ close: () => closeWebSocketServer(runtime) });
    await once(runtime, "listening");
    const runtimeAddress = runtime.address() as AddressInfo;
    runtime.on("connection", (socket) => {
      socket.on("message", (data) => runtimeReceived.push(data.toString()));
    });

    const harness = makeHarness();
    const orbId = "orb-presence";
    harness.store.seedOrb(makeOrbRow(orbId, "project-a", "running", { hostRef: "host-b" }));
    const delegate = harness.deps.hostProvider;
    const hostProvider: OrbHostProvider = {
      kind: delegate.kind,
      specGeneration: delegate.specGeneration,
      desiredSpecFingerprint: (input) => delegate.desiredSpecFingerprint(input),
      provision: (task, request, context) => delegate.provision(task, request, context),
      start: (task, ref, context) => delegate.start(task, ref, context),
      stop: (task, ref, context) => delegate.stop(task, ref, context),
      discardCompute: (task, request, context) => delegate.discardCompute(task, request, context),
      destroy: (task, id, context) => delegate.destroy(task, id, context),
      listManagedHosts: (task, context) => delegate.listManagedHosts(task, context),
      observe: (_task, ref) =>
        ResultAsync.fromSafePromise(Promise.resolve()).map(() => ({
          ref,
          orbId,
          incarnation: 0,
          specFingerprint: null,
          state: "running" as const,
          runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
        })),
    };

    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    await registerLiveProxy(app, new NoSimulationTask("live proxy test", false), {
      ...harness.deps,
      hostProvider,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const proxyAddress = app.server.address() as AddressInfo;

    const browser = new WebSocket(
      `ws://127.0.0.1:${proxyAddress.port}/api/v1/orbs/${orbId}/live`,
      RUNTIME_SUBPROTOCOL,
    );
    openServers.push({
      close: async () => {
        browser.terminate();
      },
    });
    await once(browser, "open");

    const hello = JSON.stringify({
      v: 1,
      type: "client.hello",
      clientInstanceId: "tab-1",
      afterRecordId: null,
    });
    const request = JSON.stringify({
      v: 1,
      type: "client.request",
      requestId: "req-1",
      action: { type: "abort", operationId: "op-1" },
    });
    browser.send(hello);
    browser.send(JSON.stringify({ v: 1, type: "client.presence", visible: true }));
    browser.send(request);

    await until(() => runtimeReceived.length >= 2);
    // The presence frame was consumed by the proxy, everything else forwarded.
    expect(runtimeReceived).toEqual([hello, request]);
    expect(harness.deps.control.hasVisibleBrowser(orbId)).toBe(true);
    // The client request refreshed the advisory activity timestamp.
    await until(() => harness.store.orbSnapshot(orbId)?.lastBusyAt != null);

    browser.send(JSON.stringify({ v: 1, type: "client.presence", visible: false }));
    await until(() => !harness.deps.control.hasVisibleBrowser(orbId));

    browser.close();
    await once(browser, "close");
    await until(() => !harness.deps.control.hasVisibleBrowser(orbId));
  });
});

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
