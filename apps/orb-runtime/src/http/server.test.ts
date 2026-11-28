import { on, once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  CAPABILITY_GOAL,
  type ClientAction,
  type GoalView,
  RUNTIME_SUBPROTOCOL,
  type ServerFrame,
  ServerFrameSchema,
} from "@pi-orb/protocol";
import { err, ok, okAsync } from "neverthrow";
import { Check } from "typebox/value";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import type { OrbAgent } from "../domain/orb-agent.ts";
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

async function receive(
  socket: WebSocket,
  text: string,
  until = "request.result",
  observe?: (frame: ServerFrame) => void,
) {
  const messages = on(socket, "message", { close: ["close"] });
  socket.send(text);
  for await (const [data] of messages) {
    const frame = JSON.parse(data.toString()) as ServerFrame;
    expect(Check(ServerFrameSchema, frame)).toBe(true);
    observe?.(frame);
    if (until !== "sync.completed") expect(frame.type).toBe(until);
    if (frame.type === until) return frame;
  }
  throw new Error("connection closed before response");
}

function withoutGoals(frame: ServerFrame): void {
  if (frame.type === "server.welcome") expect(frame.capabilities).not.toContain(CAPABILITY_GOAL);
  if (frame.type === "runtime.event") expect(frame.event.type).not.toBe("goal_state");
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
    if (phase === "after hello") await receive(socket, hello, "sync.completed", withoutGoals);
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
    if (phase === "before hello") await receive(socket, hello, "sync.completed", withoutGoals);
    const submitMessage = vi.spyOn(agent, "submitMessage");
    expect(
      await receive(
        socket,
        JSON.stringify({
          ...request,
          requestId: "goal",
          action: { type: "goal_set", objective: "Ship the fix" },
        }),
      ),
    ).toMatchObject({
      requestId: "goal",
      result: { type: "rejected", error: { code: "unsupported", retryable: false } },
    });
    expect(submitMessage).not.toHaveBeenCalled();
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
    await receive(reconnect, hello, "sync.completed", withoutGoals);
    expect(await receive(reconnect, JSON.stringify(request))).toMatchObject({
      result: { type: "settings_applied", duplicate: true },
    });
    expect(changeSettings).toHaveBeenCalledTimes(2);
  },
);

it("negotiates verified goal support, forwards native state, and admits only supported actions", async () => {
  const active = { revision: "1", objective: "Ship the fix", status: "active" } as const;
  let goal: GoalView | null | undefined;
  let activity: "idle" | "busy" = "idle";
  const listeners = new Set<(frame: ServerFrame) => void>();
  const observeGoal = (value: GoalView | null) => {
    goal = value;
    for (const listener of listeners) {
      listener({ v: 1, type: "runtime.event", at: "now", event: { type: "goal_state", goal } });
    }
  };
  const canChangeGoal = vi.fn<NonNullable<OrbAgent["canChangeGoal"]>>(() => ok(undefined));
  const changeGoal = vi.fn<NonNullable<OrbAgent["changeGoal"]>>(() => okAsync(undefined));
  const agent: Pick<
    OrbAgent,
    | "runtimeInstanceId"
    | "sessionId"
    | "snapshot"
    | "gateView"
    | "liveView"
    | "subscribe"
    | "canChangeGoal"
    | "changeGoal"
  > = {
    runtimeInstanceId: "runtime",
    sessionId: () => "session",
    snapshot: () =>
      ok({
        orbId: "orb",
        runtimeInstanceId: "runtime",
        session: { id: "session", overflow: {} },
        records: [],
        headId: null,
        activity,
        ...(goal === undefined ? {} : { goal }),
      }),
    gateView: () => ({
      acceptingWork: true,
      activeOperationId: activity === "busy" ? "op" : null,
      headId: null,
      activity,
    }),
    liveView: () => null,
    subscribe: (listener: (frame: ServerFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    canChangeGoal,
    changeGoal,
  };
  const app = buildRuntimeServer(
    agent as OrbAgent,
    {
      closeAll: () => undefined,
    } as unknown as TerminalManager,
  );
  const sockets: WebSocket[] = [];
  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
  });
  await app.ready();
  const connect = async (observe?: (frame: ServerFrame) => void) => {
    const socket = await app.injectWS("/v1/live", {
      headers: { "sec-websocket-protocol": RUNTIME_SUBPROTOCOL },
    });
    sockets.push(socket);
    await receive(socket, hello, "sync.completed", observe);
    return socket;
  };
  const set = { type: "goal_set", objective: active.objective } as const;
  const clear = { type: "goal_clear", revision: active.revision } as const;
  const command = (socket: WebSocket, requestId: string, action: ClientAction) =>
    receive(socket, JSON.stringify({ ...request, requestId, action }));

  const early = await connect(withoutGoals);
  expect(await command(early, "early", set)).toMatchObject({
    result: { type: "rejected", error: { code: "unsupported", retryable: false } },
  });
  expect(canChangeGoal).not.toHaveBeenCalled();
  const rehandshake = once(early, "close");
  observeGoal(null);
  expect(await rehandshake).toMatchObject([1013, expect.any(Buffer)]);

  const sync: ServerFrame[] = [];
  const ready = await connect((frame) => sync.push(frame));
  expect(sync[0]).toMatchObject({
    type: "server.welcome",
    capabilities: expect.arrayContaining([CAPABILITY_GOAL]),
  });
  expect(sync.slice(-2)).toMatchObject([
    { type: "runtime.event", event: { type: "goal_state", goal: null } },
    { type: "sync.completed" },
  ]);
  const live = once(ready, "message");
  observeGoal(active);
  expect(JSON.parse((await live)[0].toString())).toMatchObject({
    type: "runtime.event",
    event: { type: "goal_state", goal: active },
  });
  const resumed: ServerFrame[] = [];
  const reconnect = await connect((frame) => resumed.push(frame));
  expect(resumed.at(-2)).toMatchObject({
    type: "runtime.event",
    event: { type: "goal_state", goal: active },
  });
  expect(await command(ready, "set", set)).toMatchObject({
    result: { type: "goal_applied", duplicate: false },
  });
  expect(await command(reconnect, "set", set)).toMatchObject({
    result: { type: "goal_applied", duplicate: true },
  });
  for (const type of ["goal_pause", "goal_resume"] as const) {
    expect(await command(ready, type, { type, revision: active.revision })).toMatchObject({
      result: { type: "rejected", error: { code: "unsupported", retryable: false } },
    });
  }

  activity = "busy";
  expect(await command(ready, "busy-set", set)).toMatchObject({
    result: { type: "rejected", error: { code: "busy", retryable: true } },
  });
  expect(await command(ready, "busy-clear", clear)).toMatchObject({
    result: {
      type: "rejected",
      error: {
        code: "busy",
        message: "Abort the current turn before clearing.",
        retryable: true,
      },
    },
  });
  expect(canChangeGoal.mock.calls).toEqual([[set]]);

  activity = "idle";
  canChangeGoal.mockReturnValueOnce(err({ code: "busy", message: "Query is not ready." }));
  expect(await command(ready, "closing-clear", clear)).toMatchObject({
    result: {
      type: "rejected",
      error: { code: "busy", message: "Query is not ready.", retryable: true },
    },
  });
  canChangeGoal.mockReturnValueOnce(err({ code: "invalid_request", message: "Stale goal." }));
  expect(await command(ready, "stale-clear", { ...clear, revision: "old" })).toMatchObject({
    result: { type: "rejected", error: { code: "invalid_request", retryable: false } },
  });
  expect(await command(ready, "clear", clear)).toMatchObject({
    result: { type: "goal_applied", duplicate: false },
  });
  expect(changeGoal.mock.calls).toEqual([[set], [clear]]);
});
