import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { monitorWebSocketLiveness } from "./websocket-heartbeat.ts";

class FakeSocket extends EventEmitter {
  readonly ping = vi.fn();
  readonly terminate = vi.fn(() => this.emit("close"));
}

afterEach(() => vi.useRealTimers());

describe("WebSocket liveness monitor", () => {
  it("terminates a half-open peer that stops answering protocol pings", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const timedOut = vi.fn();
    monitorWebSocketLiveness(socket as unknown as WebSocket, {
      intervalMs: 10,
      onTimeout: timedOut,
    });

    // This models the observed browser-side failure: the WebSocket object
    // still looks open to the proxy, but the peer no longer processes traffic.
    vi.advanceTimersByTime(10);
    expect(socket.ping).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);

    expect(timedOut).toHaveBeenCalledOnce();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("keeps a responsive peer open across successive probes", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.ping.mockImplementation(() => socket.emit("pong"));
    monitorWebSocketLiveness(socket as unknown as WebSocket, { intervalMs: 10 });

    vi.advanceTimersByTime(100);

    expect(socket.ping).toHaveBeenCalledTimes(10);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("stops probing after the socket closes", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    monitorWebSocketLiveness(socket as unknown as WebSocket, { intervalMs: 10 });

    socket.emit("close");
    vi.advanceTimersByTime(100);

    expect(socket.ping).not.toHaveBeenCalled();
  });
});
