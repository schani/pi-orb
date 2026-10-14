import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type ClientRequest,
  RUNTIME_SUBPROTOCOL,
  type ServerFrame,
  ServerFrameSchema,
} from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { PiOrbAgent, type PiSession } from "../pi/agent.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { MemoryIdleStopFence } from "../testkit/idle-stop-fence.ts";
import { buildRuntimeServer } from "./server.ts";

const hello = JSON.stringify({
  v: 1,
  type: "client.hello",
  clientInstanceId: "test",
  afterRecordId: null,
});
const request: ClientRequest = {
  v: 1,
  type: "client.request",
  requestId: "request",
  action: { type: "set_thinking", thinkingLevel: "high" },
};

function receive(
  socket: WebSocket,
  text: string,
  until = "request.result",
): Promise<ServerFrame[]> {
  return new Promise<ServerFrame[]>((resolve, reject) => {
    const frames: ServerFrame[] = [];
    const cleanup = () => {
      socket.off("message", message);
      socket.off("close", closed);
      socket.off("error", failed);
      process.off("uncaughtExceptionMonitor", failed);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new Error("connection closed before response"));
    const message = (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      frames.push(frame);
      if (frame.type === until) {
        cleanup();
        resolve(frames);
      }
    };
    socket.on("message", message);
    socket.once("close", closed);
    socket.once("error", failed);
    process.once("uncaughtExceptionMonitor", failed);
    socket.send(text);
  }).then((frames) => {
    for (const frame of frames) expect(Check(ServerFrameSchema, frame)).toBe(true);
    return frames;
  });
}

async function fixture() {
  const agent = new PiOrbAgent({
    orbId: "test",
    repositoryUrl: "https://example.com/repo",
    workDir: "/unused",
    skillsDir: null,
    broker: null,
    executionId: "test-host",
    idleStopFence: new MemoryIdleStopFence(),
  });
  agent.attachSession(
    { isIdle: true, subscribe: () => () => undefined } as unknown as PiSession,
    SessionManager.inMemory("/unused"),
    { summarize: () => okAsync("") },
  );
  const changeSettings = vi
    .spyOn(agent, "changeSettings")
    .mockImplementation(() => okAsync<void, never>(undefined));
  const gateView = vi.spyOn(agent, "gateView");
  const subscribe = vi.spyOn(agent, "subscribe");
  const app = buildRuntimeServer(agent, {
    closeAll: () => undefined,
  } as unknown as TerminalManager);
  const uncaught: Error[] = [];
  const recordUncaught = (error: Error) => uncaught.push(error);
  process.on("uncaughtExceptionMonitor", recordUncaught);
  const sockets: WebSocket[] = [];
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/live`, RUNTIME_SUBPROTOCOL);
    sockets.push(socket);
    await once(socket, "open");
    expect(socket.protocol).toBe(RUNTIME_SUBPROTOCOL);
    return socket;
  };
  const handshake = async (socket: WebSocket) => {
    const frames = await receive(socket, hello, "sync.completed");
    expect(frames.map((frame) => frame.type)).toEqual([
      "server.welcome",
      "sync.started",
      ...agent
        .snapshot()
        ._unsafeUnwrap()
        .records.map(() => "history.record"),
      "runtime.event",
      "sync.completed",
    ]);
    expect(frames[0]).toMatchObject({ runtimeInstanceId: agent.runtimeInstanceId });
  };
  return {
    app,
    connect,
    handshake,
    changeSettings,
    gateView,
    subscribe,
    uncaught,
    dispose: async () => {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.CLOSED) continue;
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
      await app.close();
      process.off("uncaughtExceptionMonitor", recordUncaught);
    },
  };
}

describe.each(["before hello", "after hello"] as const)("invalid runtime frames %s", (phase) => {
  it.each([
    "null",
    "true",
    "false",
    "0",
    "-1",
    '""',
    '"SECRET"',
    "[]",
    "[null]",
    "{}",
    '{"v":2,"type":"client.hello"}',
    '{"requestId":null,"content":"SECRET"}',
    '{"requestId":42,"content":"SECRET"}',
    '{"requestId":true,"content":"SECRET"}',
    '{"requestId":{},"content":"SECRET"}',
    '{"requestId":[],"content":"SECRET"}',
    "{",
  ])("rejects %s without an exception or loss of availability", async (text) => {
    const f = await fixture();
    try {
      const socket = await f.connect();
      if (phase === "after hello") await f.handshake(socket);
      const frames = await receive(socket, text, "server.error");
      expect(frames).toEqual([
        {
          v: 1,
          type: "server.error",
          at: expect.any(String),
          error: {
            code: "invalid_frame",
            message: text === "{" ? "frame is not JSON" : "unrecognized frame",
            retryable: false,
          },
        },
      ]);
      expect(f.gateView).not.toHaveBeenCalled();
      expect(f.changeSettings).not.toHaveBeenCalled();
      if (phase === "before hello") await f.handshake(socket);
      expect(await receive(socket, JSON.stringify(request))).toMatchObject([
        {
          type: "request.result",
          requestId: request.requestId,
          result: { type: "settings_applied" },
        },
      ]);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const health = await f.app.inject({ url: "/v1/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: "ready", activity: "idle" });
      await f.handshake(await f.connect());
      expect(f.uncaught).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it.each(["request", ""])(
    "correlates an invalid object with string requestId %j",
    async (requestId) => {
      const f = await fixture();
      try {
        const socket = await f.connect();
        if (phase === "after hello") await f.handshake(socket);
        expect(
          await receive(
            socket,
            JSON.stringify({ ...request, requestId, action: { type: "SECRET" } }),
          ),
        ).toEqual([
          {
            v: 1,
            type: "request.result",
            at: expect.any(String),
            requestId,
            result: {
              type: "rejected",
              error: { code: "invalid_request", message: "invalid frame", retryable: false },
            },
          },
        ]);
        expect(f.gateView).not.toHaveBeenCalled();
        expect(f.changeSettings).not.toHaveBeenCalled();
        if (phase === "before hello") await f.handshake(socket);
        expect(await receive(socket, JSON.stringify({ ...request, requestId }))).toMatchObject([
          { result: { type: "settings_applied", duplicate: false } },
        ]);
        expect(f.changeSettings).toHaveBeenCalledTimes(1);
        expect(f.uncaught).toEqual([]);
      } finally {
        await f.dispose();
      }
    },
  );
});

it("preserves hello admission, presence handling, and the runtime-wide request registry", async () => {
  const f = await fixture();
  try {
    const socket = await f.connect();
    expect(await receive(socket, JSON.stringify(request))).toMatchObject([
      {
        result: {
          type: "rejected",
          error: { code: "invalid_request", message: "requests are rejected before client.hello" },
        },
      },
    ]);
    expect(f.changeSettings).not.toHaveBeenCalled();
    await f.handshake(socket);
    // A second hello and presence must not add frames or subscriptions.
    socket.send(hello);
    socket.send(JSON.stringify({ v: 1, type: "client.presence", visible: true }));
    expect(await receive(socket, JSON.stringify(request))).toMatchObject([
      { result: { type: "settings_applied", duplicate: false } },
    ]);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    expect(await receive(socket, '{"requestId":"request","action":null}')).toMatchObject([
      { requestId: "request", result: { type: "rejected", error: { code: "invalid_request" } } },
    ]);
    expect(await receive(socket, JSON.stringify(request))).toMatchObject([
      { result: { type: "settings_applied", duplicate: true } },
    ]);
    expect(
      await receive(
        socket,
        JSON.stringify({
          ...request,
          action: { type: "set_thinking", thinkingLevel: "low" },
        }),
      ),
    ).toMatchObject([{ result: { type: "rejected", error: { code: "request_id_conflict" } } }]);
    const reconnect = await f.connect();
    await f.handshake(reconnect);
    expect(await receive(reconnect, JSON.stringify(request))).toMatchObject([
      { result: { type: "settings_applied", duplicate: true } },
    ]);
    expect(f.changeSettings).toHaveBeenCalledTimes(1);
    expect(f.uncaught).toEqual([]);
  } finally {
    await f.dispose();
  }
});
