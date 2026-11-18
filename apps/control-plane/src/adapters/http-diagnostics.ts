import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { readdirSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { err, Result, type Result as ResultType } from "neverthrow";
import { RuntimeDiagnostics } from "./runtime-diagnostics.ts";

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
  projectId: string | null;
  now(): number;
  readFdCount(): ResultType<number, FdError>;
  emit(sample: Record<string, unknown>): void;
  schedule(callback: () => void): () => void;
  createRuntime(): Pick<RuntimeDiagnostics, "sample" | typeof Symbol.dispose>;
}
const defaults: Dependencies = {
  projectId: null,
  now: () => performance.now(),
  readFdCount: readFileDescriptorCount,
  emit: (sample) => console.log(JSON.stringify(sample)),
  schedule: (callback) => {
    const timer = setInterval(callback, HTTP_SAMPLE_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
  createRuntime: () => new RuntimeDiagnostics(),
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
  transport_events_suppressed: 0,
});
interface TrackedSocket {
  readonly id: number;
  readonly started: number;
  readonly inbound: boolean;
  upgraded: boolean;
  readonly close: () => void;
  readonly error: (error: unknown) => void;
}

const errorCodes = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
  "HPE_INVALID_METHOD",
  "HPE_INVALID_HEADER_TOKEN",
  "HPE_HEADER_OVERFLOW",
  "HPE_INVALID_VERSION",
  "HPE_INVALID_CONSTANT",
  "HPE_UNEXPECTED_CONTENT_LENGTH",
]);
function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "string" && errorCodes.has(code) ? code : "other";
}

/** Bounded diagnostics: never emit request paths, raw headers, peers or error text. */
export class HttpDiagnostics {
  private readonly deps: Dependencies;
  private readonly sockets = new Map<Socket, TrackedSocket>();
  private readonly requests = new Map<ServerResponse, { started: number; cleanup(): void }>();
  private counts = counters();
  private server: Server | undefined;
  private readonly cancel: () => void;
  private readonly runtime: ReturnType<Dependencies["createRuntime"]>;
  private readonly outbound = channel("net.client.socket");
  private sampledAt: number;
  private lastPublicRequest: number | undefined;
  private disposed = false;
  private nextSocket = 0;
  private nextRequest = 0;
  private transportEvents = 0;

  constructor(deps: Partial<Dependencies> = {}) {
    this.deps = { ...defaults, ...deps };
    this.runtime = this.deps.createRuntime();
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
  stopObservingUpgrades(): void {
    this.server?.off("upgrade", this.onUpgrade);
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
  private readonly onServerError = (error: unknown): void => {
    this.counts.server_errors++;
    this.transportEvent({ event: "server_error", error_code: errorCode(error) });
  };
  private readonly onClientError = (error: unknown, socket: Socket): void => {
    this.counts.client_errors++;
    this.transportEvent({
      event: "client_error",
      error_code: errorCode(error),
      ...this.socketContext(socket),
    });
  };
  private trackSocket(socket: Socket, inbound: boolean): void {
    if (this.disposed || this.sockets.has(socket)) return;
    const error = (cause: unknown) => {
      this.counts.socket_errors++;
      if (inbound)
        this.transportEvent({
          event: "socket_error",
          error_code: errorCode(cause),
          ...this.socketContext(socket),
        });
    };
    const close = () => {
      socket.off(errorMonitor, error);
      this.sockets.delete(socket);
    };
    this.sockets.set(socket, {
      id: ++this.nextSocket,
      started: this.deps.now(),
      inbound,
      upgraded: false,
      close,
      error,
    });
    socket.once("close", close);
    socket.on(errorMonitor, error);
  }
  private readonly onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const health = request.url?.split("?")[0] === "/health";
    if (health) this.counts.health_requests_started++;
    else {
      this.counts.public_requests_started++;
      this.lastPublicRequest = this.deps.now();
    }
    const started = this.deps.now();
    const requestId = ++this.nextRequest;
    const socket = request.socket;
    const connectionId = this.sockets.get(socket)?.id ?? null;
    const header = request.headers?.["x-cloud-trace-context"];
    const trace =
      typeof header === "string"
        ? /^([a-f0-9]{32})(?:\/[0-9]{1,20})?(?:;o=[01])?$/iu.exec(header)?.[1]?.toLowerCase()
        : undefined;
    const correlatedTrace =
      trace &&
      !/^0+$/u.test(trace) &&
      this.deps.projectId &&
      /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(this.deps.projectId)
        ? `projects/${this.deps.projectId}/traces/${trace}`
        : undefined;
    const context = () => ({
      request_id: requestId,
      connection_id: connectionId,
      request_kind: health ? "health" : "public",
      duration_ms: Math.round(this.deps.now() - started),
      status_code: response.headersSent ? response.statusCode : null,
      headers_sent: response.headersSent,
      writable_finished: response.writableFinished,
      response_destroyed: response.destroyed,
      readable_ended: socket?.readableEnded ?? null,
      writable_ended: socket?.writableEnded ?? null,
      socket_destroyed: socket?.destroyed ?? null,
      ...(correlatedTrace ? { "logging.googleapis.com/trace": correlatedTrace } : {}),
    });
    const cleanup = () => {
      response.off("finish", finish);
      response.off("close", close);
      this.requests.delete(response);
    };
    const finish = () => {
      this.counts.responses_finished++;
      if (response.statusCode === 429 || response.statusCode >= 500)
        this.transportEvent({ event: "response_finished", ...context() });
      cleanup();
    };
    const close = () => {
      this.counts.responses_closed_early++;
      this.transportEvent({ event: "response_closed_early", ...context() });
      cleanup();
    };
    this.requests.set(response, { started, cleanup });
    response.once("finish", finish);
    response.once("close", close);
  };
  private socketContext(socket: Socket): Record<string, unknown> {
    const tracked = this.sockets.get(socket);
    return {
      connection_id: tracked?.id ?? null,
      connection_age_ms: tracked ? Math.round(this.deps.now() - tracked.started) : null,
      upgraded: tracked?.upgraded ?? false,
      readable_ended: socket.readableEnded,
      writable_ended: socket.writableEnded,
      socket_destroyed: socket.destroyed,
    };
  }
  private transportEvent(event: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.transportEvents >= 10) {
      this.counts.transport_events_suppressed++;
      return;
    }
    this.transportEvents++;
    this.emit({ message: "control-plane.http.transport", pid: process.pid, ...event });
  }
  sample(): void {
    if (this.disposed) return;
    const now = this.deps.now();
    let inbound = 0;
    let upgraded = 0;
    let halfClosed = 0;
    let oldestInbound = 0;
    let oldestUpgraded = 0;
    for (const [socket, tracked] of this.sockets) {
      const age = Math.round(now - tracked.started);
      if (tracked.inbound) {
        inbound++;
        oldestInbound = Math.max(oldestInbound, age);
        if (socket.readableEnded && !socket.writableEnded && !socket.destroyed) halfClosed++;
      }
      if (tracked.upgraded) {
        upgraded++;
        oldestUpgraded = Math.max(oldestUpgraded, age);
      }
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
      inbound_half_closed_connections: halfClosed,
      oldest_inbound_connection_ms: oldestInbound,
      oldest_upgraded_connection_ms: oldestUpgraded,
      requests_in_flight: this.requests.size,
      oldest_request_ms: Math.round(oldest),
      last_public_request_age_ms:
        this.lastPublicRequest === undefined ? -1 : Math.round(now - this.lastPublicRequest),
      fd_count: fds.isOk() ? fds.value : null,
      fd_sample_status: fds.isOk() ? "ok" : fds.error.code,
      ...this.runtime.sample(),
      ...this.counts,
    };
    this.counts = counters();
    this.transportEvents = 0;
    this.sampledAt = now;
    this.emit(sample);
  }
  private emit(sample: Record<string, unknown>): void {
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
    this.runtime[Symbol.dispose]();
    this.disposed = true;
    this.outbound.unsubscribe(this.onOutbound);
    this.server?.off("request", this.onRequest);
    this.server?.off("connection", this.onConnection);
    this.stopObservingUpgrades();
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
