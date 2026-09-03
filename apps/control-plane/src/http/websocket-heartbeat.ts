import type { WebSocket } from "ws";

export const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 15_000;

export interface WebSocketLivenessOptions {
  readonly intervalMs?: number;
  readonly onTimeout?: () => void;
}

/**
 * Detects a transport that remains locally OPEN after its peer or network path
 * has disappeared. `ws` clients and browsers answer protocol pings without
 * depending on page JavaScript, so background-tab timer throttling does not
 * create false failures.
 */
export function monitorWebSocketLiveness(
  socket: WebSocket,
  options: WebSocketLivenessOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? WEBSOCKET_HEARTBEAT_INTERVAL_MS;
  let answeredLastProbe = true;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off("pong", markAlive);
    socket.off("close", stop);
    socket.off("error", stop);
  };
  const markAlive = (): void => {
    answeredLastProbe = true;
  };
  const timer = setInterval(() => {
    if (!answeredLastProbe) {
      options.onTimeout?.();
      stop();
      try {
        socket.terminate();
      } catch {
        // A concurrent close already made the transport terminal.
      }
      return;
    }
    answeredLastProbe = false;
    try {
      socket.ping();
    } catch {
      // `error`/`close` owns cleanup; if neither arrives, the next probe
      // terminates the socket as unresponsive.
    }
  }, intervalMs);
  timer.unref();

  socket.on("pong", markAlive);
  socket.once("close", stop);
  socket.once("error", stop);
  return stop;
}
