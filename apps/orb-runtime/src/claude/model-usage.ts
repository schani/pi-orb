import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClaudeModelCall } from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";

export type { ClaudeModelCall } from "@pi-orb/protocol";

const LOGS_PATH = "/v1/logs";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface OtlpParseError {
  readonly code: "invalid_otlp_logs";
  readonly message: string;
}

type Attributes = ReadonlyMap<string, unknown>;

function attributes(list: unknown): Attributes {
  const map = new Map<string, unknown>();
  if (!Array.isArray(list)) return map;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const { key, value } = entry as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    map.set(key, v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue);
  }
  return map;
}

const text = (attrs: Attributes, key: string): string | undefined => {
  const value = attrs.get(key);
  return typeof value === "string" ? value : undefined;
};
// OTLP JSON encodes 64-bit integers as strings or numbers.
const number = (attrs: Attributes, key: string): number | undefined => {
  const value = attrs.get(key);
  const parsed = typeof value === "string" && value !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};
function modelCall(attrs: Attributes): Result<ClaudeModelCall | null, OtlpParseError> {
  const event = text(attrs, "event.name");
  if (event !== "api_request" && event !== "api_error") return ok(null);
  const at = text(attrs, "event.timestamp");
  const model = text(attrs, "model");
  const querySource = text(attrs, "query_source");
  const durationMs = number(attrs, "duration_ms");
  if (at === undefined || model === undefined)
    return err({ code: "invalid_otlp_logs", message: `${event} lacks model or time.` });
  const base = {
    at,
    model,
    ...(querySource === undefined ? {} : { querySource }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
  if (event === "api_error")
    return ok({ ...base, outcome: "error", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const input = number(attrs, "input_tokens");
  const output = number(attrs, "output_tokens");
  const cacheRead = number(attrs, "cache_read_tokens");
  const cacheWrite = number(attrs, "cache_creation_tokens");
  const costUsd = number(attrs, "cost_usd");
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    costUsd === undefined
  )
    return err({ code: "invalid_otlp_logs", message: "api_request lacks token counts or cost." });
  return ok({ ...base, outcome: "ok", input, output, cacheRead, cacheWrite, costUsd });
}

/** Model calls in an OTLP/JSON logs export (`ExportLogsServiceRequest`); other events and services are ignored. */
export function parseOtlpLogs(body: unknown): Result<ClaudeModelCall[], OtlpParseError> {
  const invalid = (message: string) =>
    err<never, OtlpParseError>({ code: "invalid_otlp_logs", message });
  if (typeof body !== "object" || body === null) return invalid("Body is not an object.");
  const resourceLogs = (body as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) return invalid("resourceLogs is not an array.");
  const calls: ClaudeModelCall[] = [];
  for (const resource of resourceLogs) {
    const { resource: meta, scopeLogs } = (resource ?? {}) as {
      resource?: unknown;
      scopeLogs?: unknown;
    };
    // Shell commands inherit the exporter environment; an instrumented user program must not count.
    if (
      text(attributes((meta as { attributes?: unknown })?.attributes), "service.name") !==
      "claude-code"
    )
      continue;
    if (!Array.isArray(scopeLogs)) return invalid("scopeLogs is not an array.");
    for (const scope of scopeLogs) {
      const records = (scope as { logRecords?: unknown })?.logRecords;
      if (!Array.isArray(records)) return invalid("logRecords is not an array.");
      for (const log of records) {
        const call = modelCall(attributes((log as { attributes?: unknown } | null)?.attributes));
        if (call.isErr()) return err(call.error);
        if (call.value !== null) calls.push(call.value);
      }
    }
  }
  return ok(calls);
}

export interface ModelUsageReceiver {
  readonly endpoint: string;
  readonly token: string;
  close(): Promise<void>;
}

export interface ModelUsageReceiverError {
  readonly code: "model_usage_receiver_unavailable";
  readonly message: string;
}

export function telemetryEnvironment(receiver: ModelUsageReceiver): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: receiver.endpoint,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `authorization=Bearer ${receiver.token}`,
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
  };
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

/** Loopback OTLP/JSON logs endpoint for Claude Code's `api_request`/`api_error` events (docs/model-usage.md). */
export function startModelUsageReceiver(
  sink: (call: ClaudeModelCall) => void,
  onRejected: (error: OtlpParseError) => void = () => undefined,
): ResultAsync<ModelUsageReceiver, ModelUsageReceiverError> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const server: Server = createServer((request, response) => {
    const reply = (status: number) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end("{}");
    };
    if (request.method !== "POST" || request.url !== LOGS_PATH) return reply(404);
    const received = Buffer.from(request.headers.authorization ?? "");
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return reply(401);
    void readBody(request).then((body) => {
      if (body === null) return reply(413);
      const calls = Result.fromThrowable(
        () => JSON.parse(body) as unknown,
        (): OtlpParseError => ({ code: "invalid_otlp_logs", message: "Body is not JSON." }),
      )().andThen(parseOtlpLogs);
      if (calls.isErr()) {
        onRejected(calls.error);
        return reply(400);
      }
      for (const call of calls.value) sink(call);
      reply(200);
    });
  });
  // Process exit is the receiver's end; it must not hold the event loop open.
  server.unref();
  return ResultAsync.fromPromise(
    new Promise<AddressInfo>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address() as AddressInfo));
    }),
    (error): ModelUsageReceiverError => ({
      code: "model_usage_receiver_unavailable",
      message: error instanceof Error ? error.message : String(error),
    }),
  ).map((address) => ({
    endpoint: `http://127.0.0.1:${address.port}${LOGS_PATH}`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }));
}
