import type { IncomingHttpHeaders } from "node:http";
import type { PreviewError } from "@pi-orb/protocol";
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { type RawData, WebSocket } from "ws";
import type { PreviewConnection } from "../domain/preview.ts";
import type { PreviewLease } from "../domain/preview-activity.ts";
import { applicationHeaders } from "./loopback.ts";

const MAX_BYTES = 1024 * 1024;
export class LoopbackWebSocketConnection implements PreviewConnection {
  private readonly headers: IncomingHttpHeaders;
  private readonly port: number;
  private readonly path: string;
  private upstream: WebSocket | undefined;
  private downstream: WebSocket | undefined;
  private lease: PreviewLease | undefined;
  private closed = false;
  private lifetime: ReturnType<typeof setTimeout> | undefined;
  private closeDeadline: ReturnType<typeof setTimeout> | undefined;
  private queuedBytes = 0;
  private readonly early: Array<{ bytes: RawData; binary: boolean }> = [];
  private readyOutcome: ResultType<void, PreviewError> | undefined;
  private readyWaiter: ((outcome: ResultType<void, PreviewError>) => void) | undefined;
  constructor(headers: IncomingHttpHeaders, port: number, path: string) {
    this.headers = headers;
    this.port = port;
    this.path = path;
  }
  cancel(): void {
    this.close();
  }
  get protocol(): string {
    return this.upstream?.protocol ?? "";
  }
  ready(): Promise<ResultType<void, PreviewError>> {
    return this.readyOutcome === undefined
      ? new Promise((resolve) => {
          this.readyWaiter = resolve;
        })
      : Promise.resolve(this.readyOutcome);
  }
  private complete(outcome: ResultType<void, PreviewError>): void {
    if (this.readyOutcome !== undefined) return;
    this.readyOutcome = outcome;
    this.readyWaiter?.(outcome);
    this.readyWaiter = undefined;
  }
  private close = (): void => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.lifetime);
    clearTimeout(this.closeDeadline);
    this.upstream?.terminate();
    this.downstream?.terminate();
    this.lease?.release();
    this.early.length = 0;
    this.complete(
      err({
        type: "preview_error",
        code: "upstream_failed",
        message: "Preview WebSocket interrupted",
      }),
    );
  };
  open(lease: PreviewLease, origin: string): () => void {
    this.lease = lease;
    const protocols = String(this.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const created = Result.fromThrowable(
      () => {
        const headers = applicationHeaders(this.headers, origin);
        delete headers["sec-websocket-key"];
        delete headers["sec-websocket-version"];
        delete headers["sec-websocket-extensions"];
        delete headers["sec-websocket-protocol"];
        return new WebSocket(`ws://127.0.0.1:${this.port}`, protocols, {
          headers,
          handshakeTimeout: 5000,
          maxPayload: MAX_BYTES,
          perMessageDeflate: false,
          finishRequest: (request) => {
            request.path = this.path;
            request.end();
          },
        });
      },
      () => null,
    )();
    if (created.isErr()) {
      this.close();
      return this.close;
    }
    const up = created.value;
    this.upstream = up;
    this.lifetime = setTimeout(this.close, 12 * 60 * 60 * 1000);
    up.on("error", this.close);
    up.once("open", () => {
      up.pause();
      lease.touch();
      this.complete(ok(undefined));
    });
    up.on("message", (bytes, binary) => {
      lease.touch();
      if (this.downstream) this.send(up, this.downstream, bytes, binary);
      else {
        const size = Buffer.byteLength(
          bytes instanceof ArrayBuffer
            ? Buffer.from(bytes)
            : Array.isArray(bytes)
              ? Buffer.concat(bytes)
              : bytes,
        );
        if (this.queuedBytes + size > MAX_BYTES) {
          this.close();
          return;
        }
        this.early.push({ bytes, binary });
        this.queuedBytes += size;
      }
    });
    up.once("close", (code, reason) => this.peerClosed(this.downstream, code, reason));
    up.once("unexpected-response", (_request, response) => {
      this.complete(
        err({
          type: "preview_error",
          code: "upstream_failed",
          message: `Preview WebSocket upgrade rejected (${response.statusCode ?? 502})`,
        }),
      );
      response.destroy();
      this.close();
    });
    return this.close;
  }
  accept(down: WebSocket): void {
    if (this.closed || !this.upstream) {
      down.terminate();
      return;
    }
    this.downstream = down;
    const up = this.upstream;
    down.on("error", this.close);
    down.on("message", (bytes, binary) => {
      this.lease?.touch();
      this.send(down, up, bytes, binary);
    });
    down.once("close", (code, reason) => this.peerClosed(up, code, reason));
    for (const frame of this.early) this.send(up, down, frame.bytes, frame.binary);
    this.early.length = 0;
    this.queuedBytes = 0;
    up.resume();
  }
  private send(source: WebSocket, destination: WebSocket, bytes: RawData, binary: boolean): void {
    const size =
      bytes instanceof ArrayBuffer
        ? bytes.byteLength
        : Array.isArray(bytes)
          ? bytes.reduce((total, chunk) => total + chunk.byteLength, 0)
          : bytes.byteLength;
    if (
      size > MAX_BYTES ||
      destination.readyState !== WebSocket.OPEN ||
      destination.bufferedAmount + size > MAX_BYTES
    ) {
      this.close();
      return;
    }
    source.pause();
    const sent = Result.fromThrowable(
      () =>
        destination.send(bytes, { binary }, (error) => {
          if (error) this.close();
          else source.resume();
        }),
      () => null,
    )();
    if (sent.isErr()) this.close();
  }
  private peerClosed(destination: WebSocket | undefined, code: number, reason: Buffer): void {
    if (this.closed) return;
    if (!destination) {
      this.close();
      return;
    }
    const sent = Result.fromThrowable(
      () => destination.close(code === 1005 || code === 1006 ? 1000 : code, reason.toString()),
      () => null,
    )();
    if (sent.isErr() || destination.readyState === WebSocket.CLOSED) {
      this.close();
      return;
    }
    this.closeDeadline ??= setTimeout(this.close, 1000);
  }
}
