import { on, once } from "node:events";
import type { AddressInfo } from "node:net";
import { RUNTIME_SUBPROTOCOL, type ServerFrame, ServerFrameSchema } from "@pi-orb/protocol";
import { okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import type { TerminalManager } from "../terminal/manager.ts";
import { ComposedClaudeFixture } from "../testkit/claude-composed.ts";
import { buildRuntimeServer } from "./server.ts";

const hello = JSON.stringify({
  v: 1,
  type: "client.hello",
  clientInstanceId: "test",
  afterRecordId: null,
});
const request = {
  v: 1,
  type: "client.request",
  requestId: "request",
  action: { type: "set_thinking", thinkingLevel: "high" },
};

async function receive(socket: WebSocket, text: string, until = "request.result") {
  const messages = on(socket, "message", { close: ["close"] });
  socket.send(text);
  for await (const [data] of messages) {
    const frame = JSON.parse(data.toString()) as ServerFrame;
    expect(Check(ServerFrameSchema, frame)).toBe(true);
    if (until !== "sync.completed") expect(frame.type).toBe(until);
    if (frame.type === until) return frame;
  }
  throw new Error("connection closed before response");
}

it.each(["before hello", "after hello"])(
  "rejects invalid runtime frames %s without losing availability",
  async (phase) => {
    const fixture = new ComposedClaudeFixture();
    onTestFinished(() => fixture.dispose());
    expect((await fixture.attach()).isOk()).toBe(true);
    const agent = fixture.agent;
    const changeSettings = vi
      .spyOn(agent, "changeSettings")
      .mockReturnValue(okAsync<void, never>(undefined));
    const gateView = vi.spyOn(agent, "gateView");
    const app = buildRuntimeServer(agent, {
      closeAll: () => undefined,
    } as unknown as TerminalManager);
    const sockets: WebSocket[] = [];
    const uncaught: Error[] = [];
    const monitor = (error: Error) => uncaught.push(error);
    process.on("uncaughtExceptionMonitor", monitor);
    onTestFinished(async () => {
      try {
        await Promise.allSettled(
          sockets.map(async (socket) => {
            if (socket.readyState === WebSocket.CLOSED) return;
            const closed = once(socket, "close");
            socket.terminate();
            await closed;
          }),
        );
        await app.close();
        expect(uncaught).toEqual([]);
      } finally {
        process.off("uncaughtExceptionMonitor", monitor);
      }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, RUNTIME_SUBPROTOCOL);
      sockets.push(socket);
      await once(socket, "open");
      return socket;
    };
    const socket = await connect();
    if (phase === "after hello") await receive(socket, hello, "sync.completed");
    const invalid = [
      null,
      true,
      false,
      0,
      "SECRET",
      [],
      {},
      { v: 2, type: "client.hello" },
      ...[null, 42, true, {}, []].map((requestId) => ({ requestId, content: "SECRET" })),
    ];
    for (const text of [...invalid.map((value) => JSON.stringify(value)), "{"]) {
      expect(await receive(socket, text, "server.error")).toEqual({
        v: 1,
        type: "server.error",
        at: expect.any(String),
        error: {
          code: "invalid_frame",
          message: text === "{" ? "frame is not JSON" : "unrecognized frame",
          retryable: false,
        },
      });
    }
    for (const requestId of ["request", ""]) {
      expect(await receive(socket, JSON.stringify({ requestId, action: "SECRET" }))).toEqual({
        v: 1,
        type: "request.result",
        at: expect.any(String),
        requestId,
        result: {
          type: "rejected",
          error: { code: "invalid_request", message: "invalid frame", retryable: false },
        },
      });
    }
    expect(gateView).not.toHaveBeenCalled();
    expect(changeSettings).not.toHaveBeenCalled();
    if (phase === "before hello") await receive(socket, hello, "sync.completed");
    for (const requestId of ["request", ""]) {
      expect(await receive(socket, JSON.stringify({ ...request, requestId }))).toMatchObject({
        requestId,
        result: { type: "settings_applied", duplicate: false },
      });
    }
    expect(await receive(socket, '{"requestId":"request","action":null}')).toMatchObject({
      requestId: "request",
      result: { type: "rejected", error: { code: "invalid_request" } },
    });
    expect(await receive(socket, JSON.stringify(request))).toMatchObject({
      result: { type: "settings_applied", duplicate: true },
    });
    const conflict = { ...request, action: { type: "set_thinking", thinkingLevel: "low" } };
    expect(await receive(socket, JSON.stringify(conflict))).toMatchObject({
      result: { type: "rejected", error: { code: "request_id_conflict" } },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const health = await app.inject({ url: "/v1/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ready", activity: "idle" });
    const reconnect = await connect();
    await receive(reconnect, hello, "sync.completed");
    expect(await receive(reconnect, JSON.stringify(request))).toMatchObject({
      result: { type: "settings_applied", duplicate: true },
    });
    expect(changeSettings).toHaveBeenCalledTimes(2);
  },
);
