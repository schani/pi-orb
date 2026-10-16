import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { RUNTIME_SUBPROTOCOL, TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentPlane, AgentSessionFacade } from "../domain/agent-ports.ts";
import { RolloutSocketRetirement } from "../domain/rollout-sockets.ts";
import { makeHarness, makeOrbRow } from "../testkit/fixtures.ts";
import { closeRolloutSocket, registerLiveProxy } from "./live-proxy.ts";

const socketAttempts = vi.hoisted(() => [] as string[]);
vi.mock("ws", async (original) => {
  const actual = await original<typeof import("ws")>();
  return {
    ...actual,
    WebSocket: class extends actual.WebSocket {
      constructor(...args: ConstructorParameters<typeof actual.WebSocket>) {
        super(...args);
        socketAttempts.push(String(args[0]));
      }
    },
  };
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  socketAttempts.length = 0;
});
const cause = { releaseId: "release-42", revision: "old-revision" };

describe("rollout socket closure", () => {
  it.each([WebSocket.OPEN, WebSocket.CLOSING])(
    "bounds state %i close and removes its listener",
    (state) => {
      const socket = Object.assign(new EventEmitter(), {
        readyState: state,
        close: vi.fn(),
        terminate: vi.fn(),
      });
      let deadline = () => {};
      const cancel = vi.fn();
      const forced = vi.fn();
      closeRolloutSocket(socket as unknown as WebSocket, forced, (_delay, callback) => {
        deadline = callback;
        return cancel;
      });
      expect(socket.close).toHaveBeenCalledWith(1012, "deployment rollover");
      deadline();
      expect(forced).toHaveBeenCalledOnce();
      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(socket.listenerCount("close")).toBe(0);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("aborts CONNECTING without waiting and does not arm a timer", () => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.CONNECTING,
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const schedule = vi.fn();
    closeRolloutSocket(socket as unknown as WebSocket, vi.fn(), schedule);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("cancels the deadline when the peer acknowledges close", () => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const cancel = vi.fn();
    closeRolloutSocket(socket as unknown as WebSocket, vi.fn(), () => cancel);
    socket.emit("close");
    expect(cancel).toHaveBeenCalledOnce();
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it.each([
    ["live", RUNTIME_SUBPROTOCOL],
    ["terminal", TERMINAL_SUBPROTOCOL],
  ])(
    "closes both %s legs and rejects new upgrades without affecting HTTP",
    async (path, protocol) => {
      const runtime = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      cleanups.push(async () => {
        for (const client of runtime.clients) client.terminate();
        await new Promise<void>((resolve) => runtime.close(() => resolve()));
      });
      await once(runtime, "listening");
      const runtimeAddress = runtime.address() as AddressInfo;
      const harness = makeHarness();
      harness.store.seedOrb(
        makeOrbRow("orb-rollout", "project-a", "running", { hostRef: "host-a" }),
      );
      const sockets = new RolloutSocketRetirement();
      const app = Fastify();
      cleanups.push(() => app.close());
      app.get("/still-http", async () => ({ ok: true }));
      await registerLiveProxy(
        app,
        new NoSimulationTask("rollout proxy", false),
        {
          ...harness.deps,
          hostProvider: {
            ...harness.deps.hostProvider,
            observe: (_task, ref) =>
              okAsync({
                ref,
                orbId: "orb-rollout",
                incarnation: 0,
                specFingerprint: null,
                state: "running" as const,
                runtimeAddress: { baseUrl: `http://127.0.0.1:${runtimeAddress.port}` },
              }),
          },
        },
        undefined,
        sockets,
      );
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      const upstreamConnected = once(runtime, "connection");
      const browser = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/v1/orbs/orb-rollout/${path}`,
        protocol,
      );
      cleanups.push(async () => {
        browser.terminate();
      });
      await once(browser, "open");
      const [upstream] = (await upstreamConnected) as [WebSocket];
      const forwarded = once(browser, "message");
      upstream.send("routing-ready");
      await forwarded;
      const browserClosed = once(browser, "close");
      const upstreamClosed = once(upstream, "close");
      expect(sockets.retire(cause)).toBe(1);
      const [code, reason] = await browserClosed;
      expect(code).toBe(1012);
      expect(reason.toString()).toBe("deployment rollover");
      expect((await upstreamClosed)[0]).toBe(1012);
      const denied = await app.inject({
        method: "GET",
        url: `/api/v1/orbs/orb-rollout/${path}`,
        headers: {
          connection: "upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      expect(denied.statusCode).toBe(503);
      expect((await app.inject("/still-http")).statusCode).toBe(200);
    },
  );
  it.each([
    ["live", RUNTIME_SUBPROTOCOL],
    ["terminal", TERMINAL_SUBPROTOCOL],
  ])("latches closure before an in-flight %s lookup completes", async (path, protocol) => {
    const harness = makeHarness();
    const orb = makeOrbRow("orb-routing", "project-a", "running", { hostRef: "host-a" });
    const sockets = new RolloutSocketRetirement();
    const observe = vi.fn(harness.deps.hostProvider.observe);
    const app = Fastify();
    cleanups.push(() => app.close());
    await registerLiveProxy(
      app,
      new NoSimulationTask("rollout routing", false),
      {
        ...harness.deps,
        store: {
          ...harness.deps.store,
          getOrb: () => {
            expect(sockets.retire(cause)).toBe(1);
            return okAsync(orb);
          },
        },
        hostProvider: { ...harness.deps.hostProvider, observe },
      },
      undefined,
      sockets,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/orbs/orb-routing/${path}`,
      protocol,
    );
    cleanups.push(async () => {
      browser.terminate();
    });
    const [code] = await once(browser, "close");
    expect(code).toBe(1012);
    expect(observe).not.toHaveBeenCalled();
    expect(harness.deps.control.hasVisibleBrowser(orb.id)).toBe(false);
  });

  it("rechecks retirement when an upgrade was already admitted by preValidation", async () => {
    const harness = makeHarness();
    const sockets = new RolloutSocketRetirement();
    const lookup = vi.fn(harness.deps.store.getOrb);
    const app = Fastify();
    cleanups.push(() => app.close());
    app.addHook("preHandler", async () => {
      sockets.retire(cause);
    });
    await registerLiveProxy(
      app,
      new NoSimulationTask("rollout upgrade race", false),
      {
        ...harness.deps,
        store: { ...harness.deps.store, getOrb: lookup },
      },
      undefined,
      sockets,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/orbs/orb-routing/live`,
      RUNTIME_SUBPROTOCOL,
    );
    cleanups.push(async () => {
      browser.terminate();
    });
    expect((await once(browser, "close"))[0]).toBe(1012);
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each([
    ["live", RUNTIME_SUBPROTOCOL, "observe"],
    ["terminal", TERMINAL_SUBPROTOCOL, "observe"],
    ["terminal", TERMINAL_SUBPROTOCOL, "binding"],
    ["live", RUNTIME_SUBPROTOCOL, "readSession"],
  ])("does not create an upstream after held %s %s %s resolves", async (path, protocol, held) => {
    const harness = makeHarness();
    const orb = makeOrbRow("orb-held", "project-a", "running", { hostRef: "host-a" });
    harness.store.seedOrb(orb);
    const sockets = new RolloutSocketRetirement();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const wait = <T>(value: T) => {
      signalStarted();
      return ResultAsync.fromSafePromise(gate).map(() => value);
    };
    const subscribe = vi.fn(() => () => {});
    const session = { subscribe } as unknown as AgentSessionFacade;
    const ownerClose = vi.fn();
    const ownerUnload = vi.fn();
    const app = Fastify();
    cleanups.push(() => app.close());
    cleanups.push(async () => {
      release();
    });
    await registerLiveProxy(
      app,
      new NoSimulationTask("rollout held routing", false),
      {
        ...harness.deps,
        ...(held === "readSession"
          ? {
              agentPlane: {
                placement: "central",
                close: ownerClose,
                unload: ownerUnload,
                readSession: () => wait(session),
              } as unknown as AgentPlane,
            }
          : {}),
        hostProvider: {
          ...harness.deps.hostProvider,
          observe: (_task, ref) => {
            const observation = {
              ref,
              orbId: orb.id,
              incarnation: 0,
              specFingerprint: null,
              state: "running" as const,
              runtimeAddress: { baseUrl: "http://127.0.0.1:1" },
            };
            return held === "observe" ? wait(observation) : okAsync(observation);
          },
          ...(held === "binding"
            ? {
                executionBinding: () =>
                  wait({
                    baseUrl: "http://127.0.0.1:1",
                    incarnation: String(orb.hostIncarnation),
                    token: "opaque",
                    cwd: "/workspace/repo",
                  }),
              }
            : {}),
        },
      },
      undefined,
      sockets,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/orbs/${orb.id}/${path}`,
      protocol,
    );
    cleanups.push(async () => {
      browser.terminate();
    });
    await once(browser, "open");
    await started;
    const closed = once(browser, "close");
    expect(sockets.retire(cause)).toBe(1);
    release();
    expect((await closed)[0]).toBe(1012);
    expect(socketAttempts.filter((url) => new URL(url).pathname.startsWith("/v1/"))).toEqual([]);
    expect(subscribe).not.toHaveBeenCalled();
    expect(ownerClose).not.toHaveBeenCalled();
    expect(ownerUnload).not.toHaveBeenCalled();
  });

  it("detaches central live without closing its owner or cancelling inference", async () => {
    const harness = makeHarness();
    const orb = makeOrbRow("orb-central", "project-a", "running", { hostRef: null });
    harness.store.seedOrb(orb);
    const sockets = new RolloutSocketRetirement();
    const unsubscribe = vi.fn();
    const ownerClose = vi.fn();
    const ownerUnload = vi.fn();
    const inference = vi.fn(() =>
      okAsync({ type: "accepted" as const, operationId: "op", duplicate: false }),
    );
    const session = {
      runtimeInstanceId: "central",
      liveView: () => null,
      snapshot: () =>
        ok({
          orbId: orb.id,
          runtimeInstanceId: "central",
          activity: "idle",
          session: { id: "s", overflow: { harness: "pi-durable" } },
          records: [],
          headId: null,
        }),
      subscribe: () => unsubscribe,
      request: inference,
    } as unknown as AgentSessionFacade;
    const app = Fastify();
    cleanups.push(() => app.close());
    await registerLiveProxy(
      app,
      new NoSimulationTask("rollout central detach", false),
      {
        ...harness.deps,
        agentPlane: {
          placement: "central",
          readSession: () => okAsync(session),
          close: ownerClose,
          unload: ownerUnload,
        } as unknown as AgentPlane,
      },
      undefined,
      sockets,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const browser = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/orbs/${orb.id}/live`,
      RUNTIME_SUBPROTOCOL,
    );
    cleanups.push(async () => {
      browser.terminate();
    });
    await once(browser, "open");
    const welcome = once(browser, "message");
    browser.send(
      JSON.stringify({ v: 1, type: "client.hello", clientInstanceId: "tab", afterRecordId: null }),
    );
    expect(JSON.parse((await welcome)[0].toString()).type).toBe("server.welcome");
    const closed = once(browser, "close");
    expect(sockets.retire(cause)).toBe(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ownerClose).not.toHaveBeenCalled();
    expect(ownerUnload).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
    expect((await closed)[0]).toBe(1012);
  });
});
