import { EventEmitter } from "node:events";
import { CAPABILITY_GOAL, type GoalView } from "@pi-orb/protocol";
import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionFacade, AgentSnapshot } from "../domain/agent-ports.ts";
import { attachCentralLive } from "./central-live.ts";

class Socket extends EventEmitter {
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.emit("close");
  }
}

function facade(snapshot: Partial<AgentSnapshot> = {}): AgentSessionFacade {
  return {
    runtimeInstanceId: "central-process",
    snapshot: () =>
      ok({
        orbId: "orb",
        runtimeInstanceId: "central-process",
        activity: "idle",
        session: { id: "session", overflow: { harness: "pi-durable" } },
        records: [],
        headId: null,
        ...snapshot,
      }),
    liveView: () => null,
    subscribe: () => () => undefined,
    request: () => okAsync({ type: "accepted", operationId: "operation", duplicate: false }),
  };
}

const hello = JSON.stringify({
  v: 1,
  type: "client.hello",
  clientInstanceId: "browser",
  afterRecordId: null,
});

describe("central browser protocol", () => {
  const goal: GoalView = { revision: "1", objective: "Ship the fix", status: "active" };

  it.each([null, goal])("synchronizes a supported goal snapshot (%j)", async (goal) => {
    const socket = new Socket();
    const request = vi.fn(() => okAsync({ type: "goal_applied" as const, duplicate: false }));
    const cleanup = attachCentralLive(socket, { ...facade({ goal }), request }, [hello]);

    const frames = socket.sent.map((text) => JSON.parse(text));
    expect(frames[0].capabilities).toContain(CAPABILITY_GOAL);
    expect(frames.at(-2)).toMatchObject({
      type: "runtime.event",
      event: { type: "goal_state", goal },
    });
    expect(frames.at(-1)).toMatchObject({ type: "sync.completed" });

    const action = { type: "goal_set", objective: "New objective" };
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ v: 1, type: "client.request", requestId: "goal", action })),
      false,
    );
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("goal", action);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "request.result",
      requestId: "goal",
      result: { type: "goal_applied", duplicate: false },
    });
    cleanup();
  });

  it("does not advertise or dispatch goals on an unsupported snapshot", () => {
    const socket = new Socket();
    const session = facade();
    const request = vi.spyOn(session, "request");
    const cleanup = attachCentralLive(socket, session, [hello]);

    const frames = socket.sent.map((text) => JSON.parse(text));
    expect(frames[0].capabilities).not.toContain(CAPABILITY_GOAL);
    expect(frames.some((frame) => frame.event?.type === "goal_state")).toBe(false);

    for (const action of [
      { type: "goal_set", objective: "Ship the fix" },
      { type: "goal_pause", revision: "1" },
      { type: "goal_resume", revision: "1" },
      { type: "goal_clear", revision: "1" },
    ]) {
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({ v: 1, type: "client.request", requestId: action.type, action }),
        ),
        false,
      );
      expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
        type: "request.result",
        requestId: action.type,
        result: { type: "rejected", error: { code: "unsupported", retryable: false } },
      });
    }
    expect(request).not.toHaveBeenCalled();
    cleanup();
  });

  it("buffers committed publications while reading an unloaded conversation asynchronously", async () => {
    const socket = new Socket();
    const base = facade();
    const delivered = new Promise<void>((done) => {
      const send = socket.send.bind(socket);
      socket.send = (value) => {
        send(value);
        if (JSON.parse(value).event?.activity === "busy") done();
      };
    });
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    let publish!: Parameters<AgentSessionFacade["subscribe"]>[0];
    const cleanup = attachCentralLive(
      socket,
      {
        ...base,
        readSnapshot: () =>
          ResultAsync.fromSafePromise(gate).andThen(() => okAsync(base.snapshot()._unsafeUnwrap())),
        subscribe: (listener) => {
          publish = listener;
          return () => undefined;
        },
      },
      [
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "browser",
          afterRecordId: null,
        }),
      ],
    );
    publish({
      v: 1,
      type: "runtime.event",
      at: new Date(0).toISOString(),
      event: { type: "status", activity: "busy" },
    });
    expect(socket.sent).toEqual([]);
    resolve();
    await delivered;
    expect(socket.sent.map((text) => JSON.parse(text).type)).toEqual([
      "server.welcome",
      "sync.started",
      "runtime.event",
      "sync.completed",
      "runtime.event",
    ]);
    cleanup();
  });
  it("handshakes directly with central ownership and replays queued hello", () => {
    const socket = new Socket();
    const hello = JSON.stringify({
      v: 1,
      type: "client.hello",
      clientInstanceId: "browser",
      afterRecordId: null,
    });
    const cleanup = attachCentralLive(socket, facade(), [hello]);
    expect(socket.sent.map((text) => JSON.parse(text).type)).toEqual([
      "server.welcome",
      "sync.started",
      "runtime.event",
      "sync.completed",
    ]);
    expect(JSON.parse(socket.sent[0] ?? "{}").runtimeInstanceId).toBe("central-process");
    cleanup();
  });

  it("closes a revoked owner connection and fences its late publications", () => {
    const socket = new Socket();
    let publish!: Parameters<AgentSessionFacade["subscribe"]>[0];
    let invalidate!: () => void;
    let released = false;
    const closes: unknown[][] = [];
    socket.close = (...args: unknown[]) => {
      closes.push(args);
      socket.emit("close");
    };
    attachCentralLive(
      socket,
      {
        ...facade(),
        subscribe: (listener, onInvalidated) => {
          publish = listener;
          invalidate = onInvalidated!;
          return () => {
            released = true;
          };
        },
      },
      [
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "browser",
          afterRecordId: null,
        }),
      ],
    );
    expect(invalidate).toBeTypeOf("function");
    invalidate();
    const count = socket.sent.length;
    publish({
      v: 1,
      type: "runtime.event",
      at: new Date(0).toISOString(),
      event: { type: "status", activity: "busy" },
    });
    expect(closes).toEqual([[1012, "agent owner changed"]]);
    expect(released).toBe(true);
    expect(socket.sent).toHaveLength(count);
  });

  it("releases a subscription invalidated synchronously during attachment", () => {
    const socket = new Socket();
    const closes: unknown[][] = [];
    let released = false;
    socket.close = (...args: unknown[]) => {
      closes.push(args);
      socket.emit("close");
    };
    attachCentralLive(
      socket,
      {
        ...facade(),
        subscribe: (_listener, onInvalidated) => {
          onInvalidated?.();
          return () => {
            released = true;
          };
        },
      },
      [
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "browser",
          afterRecordId: null,
        }),
      ],
    );
    expect(closes).toEqual([[1012, "agent owner changed"]]);
    expect(released).toBe(true);
    expect(socket.listenerCount("message")).toBe(0);
  });

  it("does not expose private instruction failures to the browser", async () => {
    const socket = new Socket();
    const cleanup = attachCentralLive(
      socket,
      {
        ...facade(),
        request: () =>
          errAsync({
            type: "runtime_client_error",
            message: "private instruction text",
            retryable: false,
            answered: true,
            code: "http_error",
          }),
      },
      [
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "browser",
          afterRecordId: null,
        }),
      ],
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          type: "client.request",
          requestId: "failure",
          action: { type: "abort", operationId: "op" },
        }),
      ),
      false,
    );
    await Promise.resolve();
    expect(socket.sent.join("\n")).not.toContain("private instruction text");
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "request.result",
      result: { type: "rejected" },
    });
    cleanup();
  });

  it("rejects invalid requests with their correlation id", () => {
    const socket = new Socket();
    const cleanup = attachCentralLive(socket, facade());
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          type: "client.request",
          requestId: "bad",
          action: { type: "unknown" },
        }),
      ),
      false,
    );
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({
      type: "request.result",
      requestId: "bad",
      result: { type: "rejected", error: { code: "invalid_request" } },
    });
    cleanup();
  });

  it("rejects requests before hello and unsubscribes on close", () => {
    const socket = new Socket();
    let released = false;
    const session = facade();
    attachCentralLive(socket, {
      ...session,
      subscribe: () => () => {
        released = true;
      },
    });
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          type: "client.request",
          requestId: "before",
          action: { type: "abort", operationId: "operation" },
        }),
      ),
      false,
    );
    expect(JSON.parse(socket.sent[0] ?? "{}").result.error.code).toBe("invalid_request");
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          type: "client.hello",
          clientInstanceId: "browser",
          afterRecordId: null,
        }),
      ),
      false,
    );
    socket.close();
    expect(released).toBe(true);
  });
});
