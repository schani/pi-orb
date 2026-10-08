import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from "node:zlib";
import { err, ok, Result, ResultAsync } from "neverthrow";

export type WireError = { type: "inference_wire_error"; phase: "listen" | "request" | "close" };
type Terminal =
  | "complete"
  | "client_cancelled"
  | "fixture_cleanup"
  | "upstream_error"
  | "request_error";
export type InferenceWireRow = {
  sequence: number;
  method: "POST" | null;
  path: "codex_responses";
  model: "luna" | "sol" | null;
  marker: string | null;
  inputCount: number | null;
  bodyBytes: number;
  encoding: "zstd" | "gzip" | "br" | null;
  enteredAt: number;
  bodyArrivedAt: number | null;
  upstreamEnteredAt: number | null;
  headersAt: number | null;
  status: number | null;
  responseError: "no_matching_rule" | "invalid_body" | "unknown_session" | null;
  firstByteAt: number | null;
  responseBytes: number;
  endedAt: number | null;
  terminal: Terminal | null;
};
export type InferenceWireProxy = {
  baseUrl: string;
  snapshot(): InferenceWireRow[];
  idle(): Promise<void>;
  close(): ResultAsync<void, WireError>;
};

function metadata(bytes: Buffer, encoding: InferenceWireRow["encoding"]) {
  return Result.fromThrowable(
    () => {
      const decoded =
        encoding === "zstd"
          ? zstdDecompressSync(bytes)
          : encoding === "gzip"
            ? gunzipSync(bytes)
            : encoding === "br"
              ? brotliDecompressSync(bytes)
              : bytes;
      const body = JSON.parse(decoded.toString());
      const input: unknown[] | null = Array.isArray(body?.input) ? body.input : null;
      let marker: string | null = null;
      const latestUser = input?.findLast(
        (item) =>
          typeof item === "object" && item !== null && "role" in item && item.role === "user",
      );
      if (
        typeof latestUser === "object" &&
        latestUser !== null &&
        "content" in latestUser &&
        Array.isArray(latestUser.content)
      ) {
        const text = latestUser.content
          .filter((part) => part?.type === "input_text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
        if (/^(PROFILE_CASE|PROFILE_CHILD|SUBAGENT_E2E|LEAF_E2E)_[0-3]$/.test(text))
          marker = text.toLowerCase();
      }
      return {
        model:
          body?.model === "gpt-6-luna"
            ? ("luna" as const)
            : body?.model === "gpt-6.1-sol"
              ? ("sol" as const)
              : null,
        inputCount: input?.length ?? null,
        marker,
      };
    },
    () => "decode" as const,
  )().unwrapOr({ model: null, inputCount: null, marker: null });
}

function hopHeaders(connection: string | undefined): Set<string> {
  return new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(connection ?? "").split(",").map((name) => name.trim().toLowerCase()),
  ]);
}

/** Transparent, once-only test transport: no inference routing, retry or deadline. */
export function startInferenceWireProxy(
  upstream: string,
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
): ResultAsync<InferenceWireProxy, WireError> {
  const fetchUpstream = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const rows: InferenceWireRow[] = [];
  const active = new Set<AbortController>();
  const tasks = new Set<Promise<Result<void, WireError>>>();
  const sockets = new Set<Socket>();
  let sequence = 0;
  let closing = false;

  // All Node/fetch I/O is contained at this adapter boundary.
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Result<void, WireError>> => {
    const row: InferenceWireRow = {
      sequence: ++sequence,
      method: req.method === "POST" ? "POST" : null,
      path: "codex_responses",
      model: null,
      marker: null,
      inputCount: null,
      bodyBytes: 0,
      encoding: null,
      enteredAt: now(),
      bodyArrivedAt: null,
      upstreamEnteredAt: null,
      headersAt: null,
      status: null,
      responseError: null,
      firstByteAt: null,
      responseBytes: 0,
      endedAt: null,
      terminal: null,
    };
    rows.push(row);
    if (rows.length > 64) rows.shift();
    const controller = new AbortController();
    active.add(controller);
    const cancelled = () => {
      if (!res.writableFinished) controller.abort();
    };
    req.once("aborted", cancelled);
    res.once("close", cancelled);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => {
      if (reader) void ResultAsync.fromPromise(reader.cancel(), () => "cancel" as const);
    };
    controller.signal.addEventListener("abort", cancelReader);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      row.bodyArrivedAt = now();
      row.bodyBytes = bytes.length;
      const encoding = req.headers["content-encoding"];
      row.encoding =
        encoding === "zstd" || encoding === "gzip" || encoding === "br" ? encoding : null;
      Object.assign(row, metadata(bytes, row.encoding));
      if (closing || controller.signal.aborted) return ok(undefined);
      const requestHop = hopHeaders(req.headers.connection);
      const headers = Object.fromEntries(
        Object.entries(req.headers)
          .filter(
            ([name, value]) =>
              value !== undefined &&
              !requestHop.has(name) &&
              !["host", "content-length"].includes(name),
          )
          .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)]),
      );
      row.upstreamEnteredAt = now();
      const response = await fetchUpstream(`${upstream}/codex/responses`, {
        method: "POST",
        headers,
        body: bytes,
        signal: controller.signal,
        redirect: "error",
      });
      row.headersAt = now();
      row.status = response.status;
      reader = response.body?.getReader();
      if (controller.signal.aborted) {
        cancelReader();
        return ok(undefined);
      }
      const responseHop = hopHeaders(response.headers.get("connection") ?? undefined);
      res.writeHead(
        response.status,
        Object.fromEntries(
          [...response.headers].filter(
            ([name]) =>
              !responseHop.has(name) && !["content-encoding", "content-length"].includes(name),
          ),
        ),
      );
      res.flushHeaders();
      const errorChunks: Buffer[] = [];
      let errorBytes = 0;
      if (reader) {
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done || controller.signal.aborted) break;
          if (chunk.value.length > 0) row.firstByteAt ??= now();
          row.responseBytes += chunk.value.length;
          if (response.status >= 400) {
            errorBytes += chunk.value.length;
            if (errorBytes <= 1024) errorChunks.push(Buffer.from(chunk.value));
            else errorChunks.length = 0;
          }
          if (!res.write(chunk.value)) {
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off("drain", done);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              res.once("drain", done);
              controller.signal.addEventListener("abort", done, { once: true });
            });
          }
        }
      }
      if (!controller.signal.aborted) {
        if (errorBytes > 0 && errorBytes <= 1024) {
          const category = Result.fromThrowable(
            () => JSON.parse(Buffer.concat(errorChunks).toString())?.error as unknown,
            () => "decode" as const,
          )().unwrapOr(null);
          if (
            category === "no_matching_rule" ||
            category === "invalid_body" ||
            category === "unknown_session"
          )
            row.responseError = category;
        }
        res.end();
        row.terminal = "complete";
      }
      return ok(undefined);
    } catch {
      row.terminal = controller.signal.aborted
        ? null
        : row.upstreamEnteredAt === null
          ? "request_error"
          : "upstream_error";
      if (!res.destroyed) {
        if (res.headersSent) res.destroy();
        else res.writeHead(502).end();
      }
      return err({ type: "inference_wire_error", phase: "request" });
    } finally {
      row.terminal ??= closing ? "fixture_cleanup" : "client_cancelled";
      row.endedAt = now();
      req.off("aborted", cancelled);
      res.off("close", cancelled);
      controller.signal.removeEventListener("abort", cancelReader);
      reader?.releaseLock();
      active.delete(controller);
    }
  };
  return Result.fromThrowable(
    () =>
      createServer((req, res) => {
        if (req.url !== "/inference/codex/responses" || req.method !== "POST") {
          res.writeHead(404).end();
          return;
        }
        const task = Promise.resolve(
          ResultAsync.fromThrowable(
            () => handle(req, res),
            (): WireError => ({ type: "inference_wire_error", phase: "request" }),
          )().andThen((result) => result),
        );
        tasks.add(task);
        void task.then(() => tasks.delete(task));
      }),
    (): WireError => ({ type: "inference_wire_error", phase: "listen" }),
  )().asyncAndThen((server) => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return ResultAsync.fromPromise(
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
      (): WireError => ({ type: "inference_wire_error", phase: "listen" }),
    ).andThen(() => {
      const address = server.address();
      if (!address || typeof address === "string")
        return err<InferenceWireProxy, WireError>({
          type: "inference_wire_error",
          phase: "listen",
        });
      const idle = async () => {
        while (tasks.size > 0) await Promise.all([...tasks]);
      };
      return ok<InferenceWireProxy, WireError>({
        baseUrl: `http://127.0.0.1:${address.port}/inference`,
        snapshot: () => rows.map((row) => ({ ...row })),
        idle,
        close: () => {
          closing = true;
          for (const controller of active) controller.abort();
          for (const socket of sockets) socket.destroy();
          return ResultAsync.fromPromise(
            (async () => {
              await idle();
              if (server.listening)
                await new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                );
            })(),
            (): WireError => ({ type: "inference_wire_error", phase: "close" }),
          );
        },
      });
    });
  });
}
