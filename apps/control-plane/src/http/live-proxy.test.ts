import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { RUNTIME_SUBPROTOCOL, TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentPlane } from "../domain/agent-ports.ts";
import type { OrbHostProvider } from "../domain/ports.ts";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { registerLiveProxy } from "./live-proxy.ts";

function delegatingProvider(
  delegate: OrbHostProvider,
  overrides: Pick<OrbHostProvider, "observe"> & Partial<Pick<OrbHostProvider, "executionBinding">>,
): OrbHostProvider {
  return {
    kind: delegate.kind,
    specGeneration: delegate.specGeneration,
    desiredSpecFingerprint: (input) => delegate.desiredSpecFingerprint(input),
    provision: (task, request, context) => delegate.provision(task, request, context),
    start: (task, ref, context) => delegate.start(task, ref, context),
    stop: (task, ref, context) => delegate.stop(task, ref, context),
    discardCompute: (task, request, context) => delegate.discardCompute(task, request, context),
    destroy: (task, id, context) => delegate.destroy(task, id, context),
    listManagedHosts: (task, context) => delegate.listManagedHosts(task, context),
    ...overrides,
  };
}

const openServers: Array<{ close: () => Promise<void> }> = [];

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe.each([
  ["live", RUNTIME_SUBPROTOCOL],
  ["terminal", TERMINAL_SUBPROTOCOL],
])("%s upstream close recovery", (path, protocol) => {
  async function connect() {
    const runtime = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    openServers.push({ close: () => closeWebSocketServer(runtime) });
    await once(runtime, "listening");
    const runtimeAddress = runtime.address() as AddressInfo;
    const connected = once(runtime, "connection");
    runtime.on("connection", (socket) => {
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });
    const harness = makeHarness();
    const orbId = "orb-close-recovery";
    harness.store.seedOrb(makeOrbRow(orbId, "project-a", "running", { hostRef: "host-a" }));
    const originalUnregister = harness.deps.control.unregisterBrowserConnection.bind(
      harness.deps.control,
    );
    const unregister = vi.spyOn(harness.deps.control, "unregisterBrowserConnection");
    let unregistered!: () => void;
    const removed = new Promise<void>((resolve) => {
      unregistered = resolve;
    });
    unregister.mockImplementation((...args) => {
      originalUnregister(...args);
      unregistered();
    });
    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    const task = new NoSimulationTask("close recovery", true);
    const log = vi.spyOn(task, "log");
    const edges = () =>
      log.mock.calls.filter(
        ([message]) => typeof message === "string" && message.startsWith("lifecycle:"),
      );
    await registerLiveProxy(app, task, {
      ...harness.deps,
      hostProvider: delegatingProvider(harness.deps.hostProvider, {
        observe: (_task, ref) =>
          okAsync({
            ref,
            orbId,
            incarnation: 0,
            specFingerprint: null,
            state: "running" as const,
            runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
          }),
      }),
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/orbs/${orbId}/${path}`,
      protocol,
    );
    openServers.push({
      close: async () => {
        if (browser.readyState === WebSocket.CLOSED) return;
        const closed = once(browser, "close");
        browser.terminate();
        await closed;
      },
    });
    await once(browser, "open");
    const [upstream] = (await connected) as [WebSocket];
    const echo = once(browser, "message");
    browser.send("bridge-ready");
    expect((await echo)[0].toString()).toBe("bridge-ready");
    const proxyBrowser = [...app.websocketServer.clients][0] ?? expect.fail("proxy peer missing");
    return { browser, proxyBrowser, upstream, log, edges, unregister, removed, orbId };
  }

  it.each([1005, 1006, 1011])(
    "closes the browser when an established runtime ends with %i",
    async (code) => {
      const { browser, proxyBrowser, upstream, log, edges, unregister, removed, orbId } =
        await connect();
      const expected = code === 1005 || code === 1006 ? 1013 : code;
      let attempted!: () => void;
      const forwarding = new Promise<void>((resolve) => {
        attempted = resolve;
      });
      const originalClose = proxyBrowser.close.bind(proxyBrowser);
      const close = vi.spyOn(proxyBrowser, "close").mockImplementation((...args) => {
        attempted();
        return originalClose(...args);
      });
      const browserClosed = once(browser, "close");
      const upstreamClosed = once(upstream, "close");
      if (code === 1005) upstream.close();
      else if (code === 1006) upstream.terminate();
      else upstream.close(code, "external-close-reason");
      await forwarding;
      // Assert before awaiting closure: the old implementation stays pingable indefinitely.
      expect(close).toHaveBeenCalledWith(
        expected,
        code === 1005 || code === 1006 ? "" : "external-close-reason",
      );
      const [browserCode, browserReason] = await browserClosed;
      await upstreamClosed;
      await removed;
      expect(browserCode).toBe(expected);
      expect(browserReason.toString()).toBe(
        code === 1005 || code === 1006 ? "" : "external-close-reason",
      );
      expect(browser.readyState).toBe(WebSocket.CLOSED);
      expect(upstream.readyState).toBe(WebSocket.CLOSED);
      expect(unregister).toHaveBeenCalledOnce();
      if (expected !== code) {
        expect(edges()).toEqual([
          [
            expect.stringMatching(
              new RegExp(
                `^lifecycle: orb=${orbId} websocket-close-normalized connectionId=(browser|terminal)-[0-9]+ path=${path} originalCode=${code} forwardedCode=${expected}$`,
              ),
            ),
          ],
        ]);
      } else expect(edges()).toEqual([]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("external-close-reason");
    },
  );

  it("terminates the real browser transport if close serialization throws", async () => {
    const { browser, proxyBrowser, upstream, log, edges, removed, orbId } = await connect();
    const originalClose = proxyBrowser.close.bind(proxyBrowser);
    let forwarded!: () => void;
    const attempted = new Promise<void>((resolve) => {
      forwarded = resolve;
    });
    // Exercise the installed ws serializer's throw on this owned socket only.
    vi.spyOn(proxyBrowser, "close").mockImplementationOnce((code) => {
      forwarded();
      originalClose(code, "private-fault-reason".repeat(10));
    });
    const terminate = vi.spyOn(proxyBrowser, "terminate");
    const browserClosed = once(browser, "close");
    const upstreamClosed = once(upstream, "close");
    upstream.close(1011, "external-close-reason");
    await attempted;
    expect(terminate).toHaveBeenCalledOnce();
    await upstreamClosed;
    expect((await browserClosed)[0]).toBe(1006);
    await removed;
    expect(edges()).toEqual([
      [
        expect.stringMatching(
          new RegExp(
            `^lifecycle: orb=${orbId} websocket-close-terminated connectionId=(browser|terminal)-[0-9]+ path=${path} originalCode=1011 forwardedCode=1011$`,
          ),
        ),
      ],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /external-close-reason|private-fault-reason/,
    );
  });
});

describe("live proxy", () => {
  it.each([
    ["live", RUNTIME_SUBPROTOCOL],
    ["terminal", TERMINAL_SUBPROTOCOL],
  ])("fences expired %s sessions while runtime routing is held", async (path, protocol) => {
    const harness = makeHarness();
    const orbId = "orb-session-expiry";
    harness.store.seedOrb(makeOrbRow(orbId, "project-a", "running", { hostRef: "host-a" }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let expire: (() => void) | undefined;
    let now = 100;
    const task = new NoSimulationTask("expiry routing", false);
    task.wallNow = () => now;
    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    app.addHook("onRequest", async (request) => {
      request.authExpiresAt = 200;
    });
    await registerLiveProxy(
      app,
      task,
      {
        ...harness.deps,
        hostProvider: {
          ...harness.deps.hostProvider,
          observe: (_task, ref) => {
            observed();
            return ResultAsync.fromSafePromise(gate).map(() => ({
              ref,
              orbId,
              incarnation: 0,
              specFingerprint: null,
              state: "running" as const,
              runtimeAddress: { baseUrl: "http://127.0.0.1:1" },
            }));
          },
        },
      },
      (_delay, callback) => {
        expire = callback;
        return () => undefined;
      },
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/orbs/${orbId}/${path}`,
      protocol,
    );
    openServers.push({
      close: async () => {
        release();
        browser.terminate();
      },
    });
    await once(browser, "open");
    await started;
    try {
      expect(expire).toBeTypeOf("function");
      const closed = once(browser, "close");
      now = 200;
      expire?.();
      const [code, reason] = await closed;
      expect(code).toBe(1008);
      expect(reason.toString()).toBe("session expired");
    } finally {
      release();
    }
  });

  it.each(["creating", "starting", "stopped", "failed"] as const)(
    "attaches central conversation and visible presence while compute is %s without a host",
    async (state) => {
      const harness = makeHarness();
      const orbId = "central-orb";
      harness.store.seedOrb(makeOrbRow(orbId, "project-a", state, { hostRef: null }));
      const session = {
        runtimeInstanceId: "central",
        snapshot: () =>
          ok({
            orbId,
            runtimeInstanceId: "central",
            activity: "idle" as const,
            session: { id: "session", overflow: { harness: "pi-durable" } },
            records: [],
            headId: null,
          }),
        liveView: () => null,
        subscribe: () => () => undefined,
        request: () => okAsync({ type: "accepted" as const, operationId: "op", duplicate: false }),
      };
      let opened = false;
      const plane = {
        placement: "central",
        session: () => (opened ? session : null),
        readSession: () => {
          opened = true;
          return okAsync(session);
        },
        health: () => {
          throw new Error("passive attachment must not open Harness");
        },
      } as unknown as AgentPlane;
      const app = Fastify({ logger: false });
      openServers.push({ close: () => app.close() });
      await registerLiveProxy(app, new NoSimulationTask("central attach", false), {
        ...harness.deps,
        agentPlane: plane,
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      const browser = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/orbs/${orbId}/live`,
        RUNTIME_SUBPROTOCOL,
      );
      openServers.push({ close: async () => browser.terminate() });
      const first = Promise.race([
        once(browser, "message").then(([data]) => JSON.parse(data.toString()).type),
        once(browser, "close").then(() => "closed"),
      ]);
      await once(browser, "open");
      browser.send(
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "tab",
          afterRecordId: null,
        }),
      );
      browser.send(JSON.stringify({ v: 1, type: "client.presence", visible: true }));
      expect(await first).toBe("server.welcome");
      expect(opened).toBe(true);
      await until(() => harness.deps.control.hasVisibleBrowser(orbId));
    },
  );
  it("rejects a connection covered by a concurrent stopping marker", async () => {
    const harness = makeHarness();
    const orbId = "orb-concurrent-stop";
    harness.store.seedOrb(
      makeOrbRow(orbId, "project-a", "running", { hostRef: "host-stop", stateVersion: 2 }),
    );
    harness.deps.control.markStopping(orbId, 3);
    // An older terminal transition completing locally must not erase the
    // newer stop command's gate.
    harness.deps.control.clearOrb(orbId);
    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    await registerLiveProxy(app, new NoSimulationTask("terminal proxy test", false), harness.deps);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const proxyAddress = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${proxyAddress.port}/api/v1/orbs/${orbId}/terminal`,
      TERMINAL_SUBPROTOCOL,
    );
    openServers.push({ close: async () => browser.terminate() });
    await once(browser, "open");
    const [code, reason] = await once(browser, "close");
    expect(code).toBe(1013);
    expect(reason.toString()).toBe("orb is not running");
  });

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
    harness.store.seedOrb(
      makeOrbRow(orbId, "project-a", "running", { hostRef: "host-a", stateVersion: 2 }),
    );
    harness.deps.control.markStopping(orbId, 1);
    const delegate = harness.deps.hostProvider;
    const hostProvider = delegatingProvider(delegate, {
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
    });

    const app = Fastify({ logger: false });
    openServers.push({ close: () => app.close() });
    await registerLiveProxy(app, new NoSimulationTask("live proxy test", false), {
      ...harness.deps,
      hostProvider,
      agentPlane: {
        placement: "host",
        session: () => null,
        health: () => {
          throw new Error("guest transport required");
        },
      } as unknown as AgentPlane,
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
    let forwardedHeaders: Record<string, unknown> = {};
    runtime.on("connection", (socket, request) => {
      forwardedHeaders = request.headers;
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
    });

    const harness = makeHarness();
    const orbId = "orb-terminal-proxy";
    harness.store.seedOrb(
      makeOrbRow(orbId, "project-a", "running", {
        hostRef: "host-terminal",
        stateVersion: 2,
      }),
    );
    // A different role completed stop/start durably; this process still
    // carries its marker from the preceding stopping episode.
    harness.deps.control.markStopping(orbId, 1);
    const delegate = harness.deps.hostProvider;
    const hostProvider = delegatingProvider(delegate, {
      observe: (_task, ref) =>
        ResultAsync.fromSafePromise(Promise.resolve()).map(() => ({
          ref,
          orbId,
          incarnation: 0,
          specFingerprint: null,
          state: "running" as const,
          runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
        })),
      executionBinding: () =>
        ResultAsync.fromSafePromise(
          Promise.resolve({
            baseUrl: `http://127.0.0.1:${runtimeAddress.port}`,
            token: "scoped-secret",
            incarnation: "0",
            cwd: "/workspace",
          }),
        ),
    });
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
    expect(forwardedHeaders["authorization"]).toBe("Bearer scoped-secret");
    expect(forwardedHeaders["x-orb-incarnation"]).toBe("0");
    expect(isBinary).toBe(true);
    expect([...Buffer.from(data as Buffer)]).toEqual([0, 1, 2, 255]);

    const closed = once(browser, "close");
    let conversationClosed = false;
    harness.deps.control.registerBrowserConnection(orbId, "conversation", () => {
      conversationClosed = true;
    });
    harness.deps.control.closeBrowserConnections(orbId, "execution");
    await closed;
    expect(conversationClosed).toBe(false);
    await until(() => runtime.clients.size === 0);
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
    const hostProvider = delegatingProvider(delegate, {
      observe: (_task, ref) =>
        ResultAsync.fromSafePromise(Promise.resolve()).map(() => ({
          ref,
          orbId,
          incarnation: 0,
          specFingerprint: null,
          state: "running" as const,
          runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
        })),
    });

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
