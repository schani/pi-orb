import type { IncomingMessage } from "node:http";
import websocketPlugin from "@fastify/websocket";
import { type PreviewError, RUNTIME_SUBPROTOCOL, TERMINAL_SUBPROTOCOL } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { err, ok, Result, ResultAsync, type Result as ResultType } from "neverthrow";
import type { WebSocket } from "ws";
import type { ControlPlaneDeps } from "../domain/ports.ts";
import {
  admitPreview,
  previewCloseError,
  previewError,
  recordPreviewTransport,
} from "../domain/preview.ts";
import type { PreviewConnection, PreviewConnections } from "../domain/preview-connections.ts";
import type {
  PreviewByteSource,
  PreviewFrame,
  PreviewRuntimeTransport,
  PreviewSocket,
} from "../domain/preview-transport.ts";
import type {} from "./preview-auth-routes.ts";
import { previewRequestHeaders, previewResponseHeaders } from "./preview-headers.ts";
import type { PreviewHosts } from "./preview-host.ts";

export interface PreviewGatewayOptions {
  readonly deps: ControlPlaneDeps;
  readonly hosts: PreviewHosts;
  readonly appOrigin: string;
  readonly connections: PreviewConnections;
  readonly transport: PreviewRuntimeTransport;
}
const PREVIEW_WS_ROUTE = "/__pi_orb/gateway-ws";
export function previewRoutingUrl(
  hosts: PreviewHosts | undefined,
  request: IncomingMessage,
): string {
  return hosts?.parse(request.headers.host) &&
    request.headers.upgrade?.toLowerCase() === "websocket"
    ? PREVIEW_WS_ROUTE
    : (request.url ?? "/");
}
const failed = (): PreviewError => previewError("upstream_failed", "Preview stream interrupted");
function rawHeaders(request: FastifyRequest): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    const name = request.raw.rawHeaders[i];
    const value = request.raw.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) result.push([name, value]);
  }
  return result;
}
function source(request: FastifyRequest): PreviewByteSource {
  const iterator = request.raw[Symbol.asyncIterator]();
  return {
    read: async () =>
      ResultAsync.fromPromise(iterator.next(), failed).map((chunk) =>
        chunk.done ? null : new Uint8Array(chunk.value as Buffer),
      ),
  };
}
function status(error: PreviewError): number {
  switch (error.code) {
    case "orb_not_found":
    case "port_not_registered":
      return 404;
    case "unauthenticated":
      return 401;
    case "forbidden":
    case "reserved_port":
      return 403;
    case "invalid_request":
      return 400;
    case "deadline_exceeded":
      return 504;
    case "upstream_failed":
    case "target_refused":
      return 502;
    default:
      return 503;
  }
}
function deny(reply: FastifyReply, error: PreviewError, appOrigin: string): void {
  reply.header("cache-control", "no-store").status(status(error));
  if (
    reply.request.headers["sec-fetch-mode"] === "navigate" &&
    reply.request.headers["sec-fetch-dest"] === "document"
  ) {
    const escapeHtml = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    void reply
      .type("text/html")
      .send(
        `<!doctype html><title>Preview unavailable</title><p>${escapeHtml(error.message)}</p><a href="${escapeHtml(appOrigin)}">Dashboard</a>`,
      );
  } else void reply.send({ error, dashboard: appOrigin });
}
function write(reply: FastifyReply, bytes: Uint8Array): Promise<ResultType<void, PreviewError>> {
  const written = Result.fromThrowable(() => reply.raw.write(bytes), failed)();
  if (written.isErr()) return Promise.resolve(err(written.error));
  if (written.value) return Promise.resolve(ok(undefined));
  return new Promise((resolve) => {
    const clean = () => {
      reply.raw.off("drain", drained);
      reply.raw.off("close", closed);
      reply.raw.off("error", closed);
    };
    const drained = () => {
      clean();
      resolve(ok(undefined));
    };
    const closed = () => {
      clean();
      resolve(err(failed()));
    };
    reply.raw.once("drain", drained);
    reply.raw.once("close", closed);
    reply.raw.once("error", closed);
    if (reply.raw.destroyed) closed();
  });
}
export async function registerPreviewGateway(
  app: FastifyInstance,
  task: SimulationTask,
  options: PreviewGatewayOptions,
): Promise<void> {
  const { deps, hosts, connections, transport, appOrigin } = options;
  const prepared = new WeakMap<
    IncomingMessage,
    {
      upstream: PreviewSocket;
      ownership: PreviewConnection;
      record(phase: "connect" | "stream", error: PreviewError | null): void;
      attach(): void;
      dispose(code?: number, reason?: string): Promise<void>;
    }
  >();
  if (!app.hasDecorator("websocketServer"))
    await app.register(websocketPlugin, {
      options: {
        maxPayload: 8 * 1024 * 1024,
        perMessageDeflate: false,
        handleProtocols: (protocols, request) =>
          hosts.parse(request.headers.host)
            ? prepared.get(request)?.upstream.protocol || false
            : protocols.has(RUNTIME_SUBPROTOCOL)
              ? RUNTIME_SUBPROTOCOL
              : protocols.has(TERMINAL_SUBPROTOCOL)
                ? TERMINAL_SUBPROTOCOL
                : false,
      },
    });
  app.addHook("onRequest", async (request, reply) => {
    const target = hosts.parse(request.headers.host);
    if (!target) return;
    if (request.originalUrl.split("?")[0]?.startsWith("/__pi_orb/"))
      return deny(reply, previewError("forbidden", "Reserved preview path"), appOrigin);
    const upgrade = request.headers.upgrade;
    if (
      upgrade !== undefined &&
      (upgrade.toLowerCase() !== "websocket" || request.headers.origin !== target.origin)
    )
      return deny(
        reply,
        previewError("forbidden", "Preview WebSocket origin or upgrade denied"),
        appOrigin,
      );
    if (!request.previewIdentity)
      return deny(
        reply,
        previewError("unauthenticated", "Preview authentication required"),
        appOrigin,
      );
    const route = await admitPreview(task, deps, {
      ...target,
      expiresAt: request.previewIdentity.expiresAt,
    });
    if (route.isErr()) return deny(reply, route.error, appOrigin);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const record = (phase: "connect" | "stream", error: PreviewError | null) => {
      if (!controller.signal.aborted) recordPreviewTransport(task, deps, route.value, phase, error);
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const ownership = connections.add(task, route.value, upgrade === undefined, () => {
      controller.abort();
      reply.raw.destroy();
    });
    if (ownership.isErr()) {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
      return deny(reply, ownership.error, appOrigin);
    }
    if (upgrade !== undefined) {
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const upstream = await transport.openWebSocket(
        task,
        route.value,
        request.originalUrl,
        previewRequestHeaders(rawHeaders(request), target.origin),
        protocols,
        { signal: controller.signal },
      );
      if (upstream.isErr()) {
        record("connect", upstream.error);
        await ownership.value.release(task);
        request.raw.off("aborted", abort);
        reply.raw.off("close", abort);
        return deny(reply, upstream.error, appOrigin);
      }
      record("connect", null);
      let disposed = false;
      const socket = reply.raw.socket;
      const onClose = () => {
        void dispose();
      };
      const attach = () => {
        request.raw.off("aborted", abort);
        reply.raw.off("close", abort);
        socket?.off("close", onClose);
      };
      const dispose = async (code?: number, reason?: string) => {
        if (disposed) return;
        disposed = true;
        prepared.delete(request.raw);
        if (code !== undefined && validCloseCode(code)) upstream.value.close(code, reason);
        else {
          controller.abort();
          upstream.value.close();
        }
        attach();
        await ownership.value.release(task);
      };
      socket?.once("close", onClose);
      if (controller.signal.aborted || socket?.destroyed) {
        await dispose();
        return;
      }
      prepared.set(request.raw, {
        upstream: upstream.value,
        ownership: ownership.value,
        record,
        attach,
        dispose,
      });
      return;
    }
    const response = await transport.openHttp(
      task,
      route.value,
      {
        method: request.method,
        path: request.originalUrl,
        headers: previewRequestHeaders(rawHeaders(request), target.origin),
        body: source(request),
      },
      { signal: controller.signal },
    );
    if (response.isErr()) {
      record("connect", response.error);
      await ownership.value.release(task);
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
      return deny(reply, response.error, appOrigin);
    }
    record("connect", null);
    reply.hijack();
    const headers = previewResponseHeaders(response.value.headers).flatMap(([name, value]) => [
      name,
      value,
    ]);
    const started = Result.fromThrowable(() => {
      reply.raw.writeHead(response.value.status, headers);
      reply.raw.flushHeaders();
    }, failed)();
    const pump = async () => {
      if (started.isErr()) {
        record("stream", started.error);
        reply.raw.destroy();
        return;
      }
      for (;;) {
        const chunk = await response.value.body.read();
        if (chunk.isErr()) {
          record("stream", chunk.error);
          reply.raw.destroy();
          return;
        }
        if (chunk.value === null) {
          reply.raw.end();
          return;
        }
        ownership.value.activity();
        const sent = await write(reply, chunk.value);
        if (sent.isErr()) {
          record("stream", sent.error);
          reply.raw.destroy();
          return;
        }
      }
    };
    const pumped = await ResultAsync.fromPromise(pump(), failed);
    if (pumped.isErr()) {
      record("stream", pumped.error);
      reply.raw.destroy();
    }
    response.value.dispose();
    controller.abort();
    request.raw.off("aborted", abort);
    reply.raw.off("close", abort);
    await ownership.value.release(task);
  });
  const base = new URL(hosts.baseOrigin);
  const escaped = base.host.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const constraint = new RegExp(`^p[1-9][0-9]{0,4}-o[0-9a-f-]{36}\\.${escaped}$`, "u");
  app.route({
    method: "GET",
    url: PREVIEW_WS_ROUTE,
    constraints: { host: constraint },
    handler: async (_request, reply) => reply.status(400).send(),
    wsHandler: (socket, request) => {
      const state = prepared.get(request.raw);
      if (state === undefined) {
        socket.terminate();
        return;
      }
      const browser = browserFrames(socket, (error) => state.record("stream", error));
      prepared.delete(request.raw);
      state.attach();
      const { ownership, upstream } = state;
      const abort = (code: number, reason: Buffer) => {
        void state.dispose(code, reason.toString());
      };
      socket.once("close", abort);
      const run = async () => {
        const forward = async () => {
          for (;;) {
            const frame = await browser.read();
            if (frame.isErr() || frame.value === null) {
              if (frame.isErr()) state.record("stream", frame.error);
              return;
            }
            ownership.activity();
            const sent = await upstream.write(frame.value);
            if (sent.isErr()) {
              state.record("stream", sent.error);
              return;
            }
          }
        };
        const backward = async () => {
          for (;;) {
            const frame = await upstream.read();
            if (frame.isErr() || frame.value === null) {
              const error = frame.isErr() ? frame.error : previewCloseError(upstream.closeInfo);
              if (error !== null) state.record("stream", error);
              return;
            }
            ownership.activity();
            const next = frame.value;
            const sent = await ResultAsync.fromPromise(
              new Promise<void>((resolve, reject) =>
                socket.send(next.bytes, { binary: next.binary }, (error) =>
                  error ? reject(error) : resolve(),
                ),
              ),
              failed,
            );
            if (sent.isErr()) {
              state.record("stream", sent.error);
              return;
            }
          }
        };
        await Promise.race([forward(), backward()]);
        if (
          upstream.closeInfo &&
          validCloseCode(upstream.closeInfo.code) &&
          socket.readyState === 1
        ) {
          socket.close(upstream.closeInfo.code, upstream.closeInfo.reason);
          await boundedSocketClose(socket);
        } else socket.terminate();
        socket.off("close", abort);
        await state.dispose();
      };
      void ResultAsync.fromPromise(run(), failed).mapErr((error) => {
        state.record("stream", error);
        socket.terminate();
        void state.dispose();
        return failed();
      });
    },
  });
  app.addHook("onClose", async () => connections.close(task));
}
function validCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}
function boundedSocketClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      finished();
    }, 2000);
    timeout.unref();
    const finished = () => {
      clearTimeout(timeout);
      socket.off("close", finished);
      resolve();
    };
    socket.once("close", finished);
    if (socket.readyState === 3) finished();
  });
}
function browserFrames(socket: WebSocket, report: (error: PreviewError) => void) {
  const queue: PreviewFrame[] = [];
  let bytes = 0;
  let closed = false;
  let error: PreviewError | null = null;
  let waiter: ((result: ResultType<PreviewFrame | null, PreviewError>) => void) | null = null;
  const notify = () => {
    if (!waiter) return;
    const frame = queue.shift();
    if (frame) {
      bytes -= frame.bytes.byteLength;
      const resolve = waiter;
      waiter = null;
      socket.resume();
      resolve(ok(frame));
    } else if (closed || error) {
      const resolve = waiter;
      waiter = null;
      resolve(error ? err(error) : ok(null));
    }
  };
  socket.on("message", (data, binary) => {
    const frame = {
      bytes: new Uint8Array(
        data instanceof ArrayBuffer ? data : Buffer.isBuffer(data) ? data : Buffer.concat(data),
      ),
      binary,
    };
    bytes += frame.bytes.byteLength;
    if (bytes > 1024 * 1024) {
      error = previewError("capacity_exceeded", "Preview WebSocket queue exceeded");
      report(error);
      socket.terminate();
      notify();
      return;
    }
    queue.push(frame);
    socket.pause();
    notify();
  });
  socket.on("close", () => {
    closed = true;
    notify();
  });
  socket.on("error", (cause: unknown) => {
    error =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
        ? previewError("capacity_exceeded", "Preview WebSocket frame exceeded parser budget")
        : failed();
    report(error);
    notify();
  });
  return {
    read: (): Promise<ResultType<PreviewFrame | null, PreviewError>> =>
      new Promise((resolve) => {
        waiter = resolve;
        notify();
      }),
  };
}
