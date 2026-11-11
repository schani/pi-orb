import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { readdirSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { err, Result, type Result as ResultType } from "neverthrow";

export const HTTP_SAMPLE_INTERVAL_MS = 30_000;
type FdError = { readonly code: "unsupported" | "unavailable" };
export function readFileDescriptorCount(): ResultType<number, FdError> {
  const directory =
    process.platform === "linux"
      ? "/proc/self/fd"
      : process.platform === "darwin"
        ? "/dev/fd"
        : null;
  if (directory === null) return err({ code: "unsupported" });
  return Result.fromThrowable(
    () => readdirSync(directory).length,
    (): FdError => ({ code: "unavailable" }),
  )();
}
interface Dependencies {
  now(): number;
  readFdCount(): ResultType<number, FdError>;
  emit(sample: Record<string, unknown>): void;
  schedule(callback: () => void): () => void;
}
const defaults: Dependencies = {
  now: () => performance.now(),
  readFdCount: readFileDescriptorCount,
  emit: (sample) => console.log(JSON.stringify(sample)),
  schedule: (callback) => {
    const timer = setInterval(callback, HTTP_SAMPLE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
};
const counters = () => ({
  connections_accepted: 0,
  public_requests_started: 0,
  health_requests_started: 0,
  responses_finished: 0,
  responses_closed_early: 0,
  server_errors: 0,
  client_errors: 0,
  socket_errors: 0,
});
interface TrackedSocket {
  readonly inbound: boolean;
  upgraded: boolean;
  readonly close: () => void;
  readonly error: () => void;
}

/** Aggregate diagnostics only: never emit request paths, headers, peers or error text. */
export class HttpDiagnostics {
  private readonly deps: Dependencies;
  private readonly sockets = new Map<Socket, TrackedSocket>();
  private readonly requests = new Map<ServerResponse, { started: number; cleanup(): void }>();
  private counts = counters();
  private server: Server | undefined;
  private readonly cancel: () => void;
  private readonly outbound = channel("net.client.socket");
  private sampledAt: number;
  private lastPublicRequest: number | undefined;
  private disposed = false;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps };
    this.sampledAt = this.deps.now();
    this.outbound.subscribe(this.onOutbound);
    this.cancel = this.deps.schedule(() => this.sample());
  }
  observeServer(server: Server): void {
    this.server = server;
    server.prependListener("request", this.onRequest);
    server.on("connection", this.onConnection);
    // Observing an upgrade must not make Node accept it. Attach after routing plugins initialize.
    if (server.listenerCount("upgrade") > 0) server.on("upgrade", this.onUpgrade);
    server.on(errorMonitor, this.onServerError);
    // Fastify already owns parser-error handling. Do not replace Node's default on a bare server.
    if (server.listenerCount("clientError") > 0) server.on("clientError", this.onClientError);
  }
  private readonly onOutbound = (message: unknown): void => {
    if (
      typeof message === "object" &&
      message !== null &&
      "socket" in message &&
      message.socket instanceof Socket
    )
      this.trackSocket(message.socket, false);
  };
  private readonly onConnection = (socket: Socket): void => {
    this.counts.connections_accepted++;
    this.trackSocket(socket, true);
  };
  private readonly onUpgrade = (_request: IncomingMessage, socket: Socket): void => {
    const tracked = this.sockets.get(socket);
    if (tracked) tracked.upgraded = true;
  };
  private readonly onServerError = (): void => {
    this.counts.server_errors++;
  };
  private readonly onClientError = (): void => {
    this.counts.client_errors++;
  };
  private trackSocket(socket: Socket, inbound: boolean): void {
    if (this.disposed || this.sockets.has(socket)) return;
    const error = () => {
      this.counts.socket_errors++;
    };
    const close = () => {
      socket.off(errorMonitor, error);
      this.sockets.delete(socket);
    };
    this.sockets.set(socket, { inbound, upgraded: false, close, error });
    socket.once("close", close);
    socket.on(errorMonitor, error);
  }
  private readonly onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url?.split("?")[0] === "/health") this.counts.health_requests_started++;
    else {
      this.counts.public_requests_started++;
      this.lastPublicRequest = this.deps.now();
    }
    const cleanup = () => {
      response.off("finish", finish);
      response.off("close", close);
      this.requests.delete(response);
    };
    const finish = () => {
      this.counts.responses_finished++;
      cleanup();
    };
    const close = () => {
      this.counts.responses_closed_early++;
      cleanup();
    };
    this.requests.set(response, { started: this.deps.now(), cleanup });
    response.once("finish", finish);
    response.once("close", close);
  };
  sample(): void {
    if (this.disposed) return;
    const now = this.deps.now();
    let inbound = 0;
    let upgraded = 0;
    for (const socket of this.sockets.values()) {
      if (socket.inbound) inbound++;
      if (socket.upgraded) upgraded++;
    }
    let oldest = 0;
    for (const request of this.requests.values()) oldest = Math.max(oldest, now - request.started);
    const fds = this.deps.readFdCount();
    const sample = {
      message: "control-plane.http",
      pid: process.pid,
      interval_ms: Math.round(now - this.sampledAt),
      listening: this.server?.listening ? 1 : 0,
      inbound_connections: inbound,
      upgraded_connections: upgraded,
      outbound_connections: this.sockets.size - inbound,
      requests_in_flight: this.requests.size,
      oldest_request_ms: Math.round(oldest),
      last_public_request_age_ms:
        this.lastPublicRequest === undefined ? -1 : Math.round(now - this.lastPublicRequest),
      fd_count: fds.isOk() ? fds.value : null,
      fd_sample_status: fds.isOk() ? "ok" : fds.error.code,
      ...this.counts,
    };
    this.counts = counters();
    this.sampledAt = now;
    // A closed diagnostic sink must not change HTTP or shutdown behavior.
    try {
      this.deps.emit(sample);
    } catch {
      /* Best-effort stdout adapter. */
    }
  }
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.cancel();
    this.sample();
    this.disposed = true;
    this.outbound.unsubscribe(this.onOutbound);
    this.server?.off("request", this.onRequest);
    this.server?.off("connection", this.onConnection);
    this.server?.off("upgrade", this.onUpgrade);
    this.server?.off(errorMonitor, this.onServerError);
    this.server?.off("clientError", this.onClientError);
    for (const request of this.requests.values()) request.cleanup();
    for (const [socket, tracked] of this.sockets) {
      socket.off("close", tracked.close);
      socket.off(errorMonitor, tracked.error);
    }
    this.sockets.clear();
  }
}
