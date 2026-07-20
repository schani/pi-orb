import { once } from "node:events";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { RUNTIME_SUBPROTOCOL } from "@pi-orb/protocol";
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
      provision: (task, request, context) => delegate.provision(task, request, context),
      start: (task, ref, context) => delegate.start(task, ref, context),
      stop: (task, ref, context) => delegate.stop(task, ref, context),
      listManagedHosts: (task, context) => delegate.listManagedHosts(task, context),
      observe: (_task, ref) => {
        markObserveStarted();
        return ResultAsync.fromSafePromise(observeGate).map(() => ({
          ref,
          orbId,
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
});
