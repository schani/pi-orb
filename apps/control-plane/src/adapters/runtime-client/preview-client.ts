import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  PREVIEW_ADMISSION_HEADER,
  PREVIEW_ERROR_HEADER,
  PREVIEW_PATH_HEADER,
  type PreviewError,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, Result, ResultAsync, type Result as ResultType } from "neverthrow";
import { WebSocket } from "ws";
import type { OperationContext } from "../../domain/ports.ts";
import type { PreviewRoute } from "../../domain/preview.ts";
import { previewError } from "../../domain/preview.ts";
import type {
  PreviewByteSource,
  PreviewFrame,
  PreviewHeaders,
  PreviewHttpRequest,
  PreviewHttpResponse,
  PreviewRuntimeTransport,
  PreviewSocket,
} from "../../domain/preview-transport.ts";

export const PREVIEW_QUEUE_BYTES = 1024 * 1024;
function failure(error: unknown): PreviewError {
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "preview_error"
  )
    return error as PreviewError;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return previewError(
    code === "ECONNREFUSED"
      ? "target_refused"
      : code === "ABORT_ERR"
        ? "cancelled"
        : "upstream_failed",
    "Preview runtime transport failed",
  );
}
export function nodePreviewSource(stream: IncomingMessage): PreviewByteSource {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    read: async () =>
      ResultAsync.fromPromise(iterator.next(), failure).map((chunk) =>
        chunk.done ? null : new Uint8Array(chunk.value as Buffer),
      ),
  };
}
function encodedPath(path: string): ResultType<string, PreviewError> {
  const bytes = Buffer.from(path, "utf8");
  if (
    bytes.length > 12288 ||
    bytes.toString("utf8") !== path ||
    !path.startsWith("/") ||
    [...path].some(
      (character) =>
        character.charCodeAt(0) <= 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    )
  )
    return err(previewError("invalid_request", "Invalid preview path"));
  return ok(bytes.toString("base64url"));
}
function runtimeError(response: IncomingMessage): PreviewError | null {
  const marker = response.headers[PREVIEW_ERROR_HEADER];
  const codes: readonly PreviewError["code"][] = [
    "invalid_request",
    "unauthenticated",
    "forbidden",
    "orb_not_found",
    "port_not_registered",
    "reserved_port",
    "preview_disabled",
    "unsupported_provider",
    "orb_unavailable",
    "stale_target",
    "target_refused",
    "upstream_failed",
    "deadline_exceeded",
    "capacity_exceeded",
    "cancelled",
    "store_unavailable",
  ];
  const code = codes.find((candidate) => candidate === marker);
  return code !== undefined && (response.statusCode ?? 200) >= 400
    ? previewError(code, "Preview runtime forwarding failed")
    : null;
}
function internalHeaders(
  task: SimulationTask,
  route: PreviewRoute,
  headers: PreviewHeaders,
  path: string,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of headers) {
    const name = key.toLowerCase();
    if (name.startsWith("x-pi-orb-")) continue;
    result[name] = value;
  }
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      target: route.target,
      origin: route.origin,
      expiresAt: Math.min(route.expiresAt, task.wallNow() + 10_000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", route.runtimeTokenHash)
    .update(`pi-orb-preview-admission-v1\n${payload}`)
    .digest("base64url");
  result[PREVIEW_ADMISSION_HEADER] = `${payload}.${signature}`;
  result[PREVIEW_PATH_HEADER] = path;
  return result;
}

export class NodePreviewClient implements PreviewRuntimeTransport {
  openHttp(
    task: SimulationTask,
    route: PreviewRoute,
    input: PreviewHttpRequest,
    context: OperationContext,
  ): ResultAsync<PreviewHttpResponse, PreviewError> {
    const path = encodedPath(input.path);
    if (path.isErr()) return errAsync(path.error);
    const run = new Promise<PreviewHttpResponse>((resolve, reject) => {
      const created = Result.fromThrowable(() => {
        const url = new URL(`/v1/preview/${route.target.port}`, route.baseUrl);
        return (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          method: input.method,
          headers: internalHeaders(task, route, input.headers, path.value),
          signal: context.signal,
        });
      }, failure)();
      if (created.isErr()) {
        reject(created.error);
        return;
      }
      const request = created.value;
      let disposed = false;
      let response: IncomingMessage | undefined;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(connectTimer);
        clearTimeout(headerTimer);
        request.destroy();
        response?.destroy();
      };
      const connectTimer = setTimeout(() => {
        reject(previewError("deadline_exceeded", "Preview runtime connection timed out"));
        dispose();
      }, 5000);
      const headerTimer = setTimeout(() => {
        reject(previewError("deadline_exceeded", "Preview runtime headers timed out"));
        dispose();
      }, 30000);
      request.once("socket", (socket) => {
        if (!socket.connecting) clearTimeout(connectTimer);
        else socket.once("connect", () => clearTimeout(connectTimer));
      });
      request.once("error", reject);
      request.once("response", (received) => {
        response = received;
        clearTimeout(connectTimer);
        clearTimeout(headerTimer);
        const platformError = runtimeError(received);
        if (platformError !== null) {
          reject(platformError);
          dispose();
          return;
        }
        const headers: Array<[string, string]> = [];
        for (let i = 0; i < received.rawHeaders.length; i += 2) {
          const name = received.rawHeaders[i];
          const value = received.rawHeaders[i + 1];
          if (
            name !== undefined &&
            value !== undefined &&
            !name.toLowerCase().startsWith("x-pi-orb-")
          )
            headers.push([name, value]);
        }
        resolve({
          status: received.statusCode ?? 502,
          headers,
          body: nodePreviewSource(received),
          dispose,
        });
      });
      const pump = async () => {
        for (;;) {
          const chunk = await input.body.read();
          if (chunk.isErr()) {
            reject(chunk.error);
            dispose();
            return;
          }
          if (chunk.value === null) {
            request.end();
            return;
          }
          const written = Result.fromThrowable(() => request.write(chunk.value), failure)();
          if (written.isErr()) {
            reject(written.error);
            dispose();
            return;
          }
          if (!written.value) {
            const drained = await ResultAsync.fromPromise(
              new Promise<void>((done, fail) => {
                const clean = () => {
                  request.off("drain", onDrain);
                  request.off("error", onError);
                  request.off("close", onClose);
                };
                const onDrain = () => {
                  clean();
                  done();
                };
                const onError = (error: unknown) => {
                  clean();
                  fail(error);
                };
                const onClose = () => {
                  clean();
                  fail(previewError("cancelled", "Preview upload closed"));
                };
                request.once("drain", onDrain);
                request.once("error", onError);
                request.once("close", onClose);
              }),
              failure,
            );
            if (drained.isErr()) {
              reject(drained.error);
              dispose();
              return;
            }
          }
        }
      };
      void ResultAsync.fromPromise(pump(), failure).mapErr((error) => {
        reject(error);
        dispose();
        return error;
      });
      request.once("close", () => {
        clearTimeout(connectTimer);
        clearTimeout(headerTimer);
      });
    });
    return ResultAsync.fromPromise(run, (error) =>
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "preview_error"
        ? (error as PreviewError)
        : failure(error),
    );
  }
  openWebSocket(
    task: SimulationTask,
    route: PreviewRoute,
    path: string,
    headers: PreviewHeaders,
    protocols: readonly string[],
    context: OperationContext,
  ): ResultAsync<PreviewSocket, PreviewError> {
    const encoded = encodedPath(path);
    if (encoded.isErr()) return errAsync(encoded.error);
    const created = Result.fromThrowable(
      () =>
        new WebSocket(
          `${route.baseUrl.replace(/^http/u, "ws")}/v1/preview/${route.target.port}`,
          [...protocols],
          {
            headers: internalHeaders(task, route, headers, encoded.value),
            handshakeTimeout: 5000,
            maxPayload: PREVIEW_QUEUE_BYTES,
            perMessageDeflate: false,
          },
        ),
      failure,
    )();
    if (created.isErr())
      return ResultAsync.fromSafePromise(Promise.resolve(err(created.error))).andThen(
        (value) => value,
      );
    const socket = created.value;
    return ResultAsync.fromPromise(
      new Promise<PreviewSocket>((resolve, reject) => {
        let opened = false;
        const abort = () => {
          reject(previewError("cancelled", "Preview WebSocket upgrade cancelled"));
          socket.terminate();
        };
        context.signal.addEventListener("abort", abort, { once: true });
        socket.once("close", () => {
          context.signal.removeEventListener("abort", abort);
          if (!opened)
            reject(
              previewError(
                context.signal.aborted ? "cancelled" : "upstream_failed",
                "Preview WebSocket closed before upgrade",
              ),
            );
        });
        socket.once("error", reject);
        socket.once("open", () => {
          opened = true;
          resolve(wrapPreviewSocket(socket));
        });
        socket.once("unexpected-response", (_request, response) => {
          const platformError = runtimeError(response);
          response.destroy();
          socket.terminate();
          reject(
            platformError ??
              previewError(
                response.statusCode === 401
                  ? "unauthenticated"
                  : response.statusCode === 409
                    ? "stale_target"
                    : "upstream_failed",
                "Preview WebSocket upgrade rejected",
              ),
          );
        });
        if (context.signal.aborted) abort();
      }),
      failure,
    );
  }
}

export function wrapPreviewSocket(socket: WebSocket): PreviewSocket {
  const queue: PreviewFrame[] = [];
  let queuedBytes = 0;
  let terminal: PreviewError | null = null;
  let closed = false;
  let closeInfo: PreviewSocket["closeInfo"] = null;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let waiting: ((value: ResultType<PreviewFrame | null, PreviewError>) => void) | null = null;
  const notify = () => {
    if (waiting === null) return;
    const next = queue.shift();
    if (next !== undefined) {
      queuedBytes -= next.bytes.byteLength;
      socket.resume();
      const done = waiting;
      waiting = null;
      done(ok(next));
    } else if (terminal !== null || closed) {
      const done = waiting;
      waiting = null;
      done(terminal === null ? ok(null) : err(terminal));
    }
  };
  socket.on("message", (data, binary) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.concat(data));
    if (queuedBytes + bytes.byteLength > PREVIEW_QUEUE_BYTES) {
      terminal = previewError("capacity_exceeded", "Preview WebSocket queue exceeded");
      socket.terminate();
      notify();
      return;
    }
    queue.push({ bytes, binary });
    queuedBytes += bytes.byteLength;
    socket.pause();
    notify();
  });
  socket.on("error", () => {
    terminal = previewError("upstream_failed", "Preview WebSocket interrupted");
    notify();
  });
  socket.on("close", (code, reason) => {
    closed = true;
    closeInfo = { code, reason: reason.toString() };
    clearTimeout(closeTimer);
    if (code === 1006) terminal = previewError("upstream_failed", "Preview WebSocket interrupted");
    notify();
  });
  return {
    get protocol() {
      return socket.protocol;
    },
    get closeInfo() {
      return closeInfo;
    },
    read: () =>
      new Promise((resolve) => {
        waiting = resolve;
        notify();
      }),
    write: async (frame) =>
      ResultAsync.fromPromise(
        new Promise<void>((resolve, reject) => {
          const sent = Result.fromThrowable(
            () =>
              socket.send(frame.bytes, { binary: frame.binary }, (error) =>
                error ? reject(error) : resolve(),
              ),
            failure,
          )();
          if (sent.isErr()) reject(sent.error);
        }),
        failure,
      ),
    close: (code, reason) => {
      if (code === undefined) socket.terminate();
      else if (closeTimer === undefined && !closed) {
        const closedSocket = Result.fromThrowable(() => socket.close(code, reason), failure)();
        if (closedSocket.isErr()) socket.terminate();
        else {
          closeTimer = setTimeout(() => socket.terminate(), 2000);
          closeTimer.unref();
        }
      }
    },
  };
}
