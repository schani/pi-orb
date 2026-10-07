import {
  PREVIEW_ADMISSION_HEADER,
  PREVIEW_ERROR_HEADER,
  PREVIEW_PATH_HEADER,
  type PreviewError,
} from "@pi-orb/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import type { PreviewAdmissionLease, RuntimePreviewService } from "../domain/preview.ts";
import { LoopbackHttpConnection } from "../preview/loopback.ts";
import { LoopbackWebSocketConnection } from "../preview/loopback-websocket.ts";

function previewPath(encoded: unknown): ResultType<string, PreviewError> {
  const invalid = (): PreviewError => ({
    type: "preview_error",
    code: "invalid_request",
    message: "Invalid preview path",
  });
  if (typeof encoded !== "string" || encoded.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
    return err(invalid());
  const decoded = Result.fromThrowable(() => {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 12288 || bytes.toString("base64url") !== encoded) return null;
    const path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (
      !path.startsWith("/") ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) <= 32 ||
          (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
      )
    )
      return null;
    return path;
  }, invalid)();
  return decoded.isErr()
    ? err(decoded.error)
    : decoded.value === null
      ? err(invalid())
      : ok(decoded.value);
}
function sendError(reply: FastifyReply, status: number, error: PreviewError) {
  return reply.header(PREVIEW_ERROR_HEADER, error.code).code(status).send(error);
}
export function registerPreviewRoutes(app: FastifyInstance, service: RuntimePreviewService): void {
  // This scope owns raw streaming bodies; no JSON parser may consume preview uploads.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
  const leases = new WeakMap<object, PreviewAdmissionLease>();
  const paths = new WeakMap<object, string>();
  const sockets = new WeakMap<object, LoopbackWebSocketConnection>();
  app.addHook("preClose", async () => service.closeAll());
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)
    app.route<{ Params: { port: string } }>({
      method,
      exposeHeadRoute: false,
      url: "/v1/preview/:port",
      preValidation: async (request, reply) => {
        const path = previewPath(request.headers[PREVIEW_PATH_HEADER]);
        if (path.isErr()) return sendError(reply, 400, path.error);
        const encoded = request.headers[PREVIEW_ADMISSION_HEADER];
        const websocket = request.headers.upgrade?.toLowerCase() === "websocket";
        const admission = service.admit(
          typeof encoded === "string" ? encoded : "",
          Number(request.params.port),
          websocket ? "websocket" : "http",
        );
        if (admission.isErr()) {
          const code = admission.error.code;
          return sendError(
            reply,
            code === "unauthenticated"
              ? 401
              : code === "stale_target"
                ? 409
                : code === "orb_unavailable"
                  ? 503
                  : 403,
            admission.error,
          );
        }
        leases.set(request, admission.value);
        paths.set(request, path.value);
        if (websocket) {
          const connection = new LoopbackWebSocketConnection(
            request.headers,
            Number(request.params.port),
            path.value,
          );
          const opened = service.open(admission.value, connection);
          if (opened.isErr()) return sendError(reply, 503, opened.error);
          request.raw.socket.once("close", () => connection.cancel());
          const ready = await connection.ready();
          if (ready.isErr()) return sendError(reply, 502, ready.error);
          sockets.set(request, connection);
          if (connection.protocol) request.headers["sec-websocket-protocol"] = connection.protocol;
          else delete request.headers["sec-websocket-protocol"];
        } else reply.raw.once("close", () => admission.value.release());
      },
      handler: (request, reply) => {
        const lease = leases.get(request);
        const path = paths.get(request);
        if (!lease || path === undefined) return;
        reply.hijack();
        const opened = service.open(
          lease,
          new LoopbackHttpConnection(request.raw, reply.raw, Number(request.params.port), path),
        );
        if (opened.isErr()) {
          reply.raw.writeHead(503, {
            [PREVIEW_ERROR_HEADER]: opened.error.code,
            "content-type": "application/json",
          });
          reply.raw.end(JSON.stringify(opened.error));
        }
      },
      ...(method === "GET"
        ? {
            wsHandler: (socket, request) => {
              const connection = sockets.get(request);
              if (connection) connection.accept(socket);
              else socket.terminate();
            },
          }
        : {}),
    });
}
