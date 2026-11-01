import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { PREVIEW_ERROR_HEADER, type PreviewError } from "@pi-orb/protocol";
import { Result } from "neverthrow";
import type { PreviewConnection } from "../domain/preview.ts";
import type { PreviewLease } from "../domain/preview-activity.ts";

const PLATFORM_IDENTITY = new Set([
  "x-goog-iap-jwt-assertion",
  "x-goog-authenticated-user-email",
  "x-goog-authenticated-user-id",
  "x-serverless-authorization",
]);

const MAX_STREAM_MS = 12 * 60 * 60 * 1000;
const upstreamFailure = (): PreviewError => ({
  type: "preview_error",
  code: "upstream_failed",
  message: "Preview upstream unavailable",
});
export function applicationHeaders(
  input: IncomingMessage["headers"],
  origin?: string,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  const connectionTokens = String(input.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim());
  for (const [name, value] of Object.entries(input)) {
    if (
      value === undefined ||
      name.startsWith("x-pi-orb-") ||
      PLATFORM_IDENTITY.has(name) ||
      name === "authorization" ||
      name === "host" ||
      (origin !== undefined && (name === "forwarded" || name.startsWith("x-forwarded-"))) ||
      [
        "connection",
        "upgrade",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
      ].includes(name) ||
      connectionTokens.includes(name)
    )
      continue;
    if (name === "cookie") {
      const cookies = String(value)
        .split(";")
        .map((cookie) => cookie.trim())
        .filter((cookie) => !cookie.startsWith("__Host-pi-orb-"))
        .join("; ");
      if (cookies) headers[name] = cookies;
    } else headers[name] = value;
  }
  const auth = input["x-pi-orb-preview-application-authorization"] ?? input.authorization;
  if (auth !== undefined) headers.authorization = auth;
  if (origin !== undefined) {
    const external = new URL(origin);
    headers.host = external.host;
    headers["x-forwarded-host"] = external.host;
    headers["x-forwarded-proto"] = external.protocol.slice(0, -1);
  }
  return headers;
}
function responseHeaders(input: IncomingMessage["headers"]): Record<string, string | string[]> {
  const headers = applicationHeaders(input);
  if (input.authorization !== undefined) headers.authorization = input.authorization;
  return headers;
}

export class LoopbackHttpConnection implements PreviewConnection {
  private readonly input: IncomingMessage;
  private readonly output: ServerResponse;
  private readonly port: number;
  private readonly path: string;
  constructor(input: IncomingMessage, output: ServerResponse, port: number, path: string) {
    this.input = input;
    this.output = output;
    this.port = port;
    this.path = path;
  }
  open(lease: PreviewLease, origin: string): () => void {
    const input = this.input,
      output = this.output;
    let response: IncomingMessage | undefined;
    let closed = false;
    let upstream: ReturnType<typeof httpRequest> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      clearTimeout(lifetime);
      input.unpipe();
      response?.unpipe();
      upstream?.destroy();
      response?.destroy();
      lease.release();
    };
    const fail = () => {
      if (closed) return;
      if (!output.headersSent) {
        const error = upstreamFailure();
        const sent = Result.fromThrowable(
          () => {
            output.writeHead(502, {
              "content-type": "application/json",
              [PREVIEW_ERROR_HEADER]: error.code,
            });
            output.end(JSON.stringify(error));
          },
          () => error,
        )();
        if (sent.isErr()) output.destroy();
      } else output.destroy();
      close();
    };
    const created = Result.fromThrowable(
      () =>
        httpRequest({
          hostname: "127.0.0.1",
          port: this.port,
          method: input.method,
          path: this.path,
          headers: applicationHeaders(input.headers, origin),
          agent: false,
          maxHeaderSize: 32 * 1024,
        }),
      upstreamFailure,
    )();
    if (created.isErr()) {
      fail();
      return () => undefined;
    }
    upstream = created.value;
    upstream.on("error", fail);
    input.once("aborted", close);
    input.once("error", fail);
    output.once("close", close);
    output.once("error", close);
    connectTimer = setTimeout(fail, 5000);
    headersTimer = setTimeout(fail, 30000);
    lifetime = setTimeout(fail, MAX_STREAM_MS);
    upstream.once("socket", (socket) => socket.once("connect", () => clearTimeout(connectTimer)));
    upstream.once("response", (received) => {
      response = received;
      clearTimeout(connectTimer);
      clearTimeout(headersTimer);
      const started = Result.fromThrowable(() => {
        output.writeHead(received.statusCode ?? 502, responseHeaders(received.headers));
        output.flushHeaders();
      }, upstreamFailure)();
      if (started.isErr()) {
        fail();
        return;
      }
      received.once("error", fail);
      received.once("aborted", fail);
      output.once("finish", close);
      received.pipe(output);
    });
    input.pipe(upstream);
    return () => {
      output.destroy();
      close();
    };
  }
}
