import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { TextLineReader } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  EXECUTION_CANCEL_PATH,
  EXECUTION_EXEC_PATH,
  EXECUTION_READY_PATH,
  EXECUTION_RPC_PATH,
  ExecutionExecSchema,
  type ExecutionReady,
  ExecutionRpcSchema,
  type ExecutionWireResult,
  RUNTIME_ALERT_PATH,
  type RuntimeAlertRequest,
  RuntimeAlertRequestSchema,
  type RuntimeAlertResponse,
  RuntimeHealthSchema,
} from "@pi-orb/protocol";
import Fastify from "fastify";
import type { ResultAsync } from "neverthrow";
import { Check } from "typebox/value";
import { BoundedLineReader } from "./line-reader.ts";

export const executionContext = (abortSignal?: AbortSignal): Context => ({
  abortSignal,
  value: () => undefined,
  toString: () => "remote-execution",
});
export interface ExecutionServerOptions {
  readonly token: string;
  readonly incarnation: string;
  readonly cwd: string;
  readonly ready?: () => ExecutionReady | null;
  readonly health?: () => unknown;
  readonly appendAlert?: (
    input: RuntimeAlertRequest,
  ) => ResultAsync<
    RuntimeAlertResponse,
    { readonly code: "conflict" | "unavailable"; readonly message: string }
  >;
}
const failure = (code: string, message: string): ExecutionWireResult => ({
  ok: false,
  error: { code, message },
});
function wire(
  result:
    | { ok: true; value?: unknown }
    | { ok: false; error: { code: string; message: string; path?: string; spillPath?: string } },
): ExecutionWireResult {
  if (!result.ok)
    return {
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.path ? { path: result.error.path } : {}),
        ...(result.error.spillPath ? { spillPath: result.error.spillPath } : {}),
      },
    };
  return {
    ok: true,
    value:
      result.value instanceof Uint8Array
        ? { binary: Buffer.from(result.value).toString("base64") }
        : result.value,
  };
}
/** No inference, model authentication, MCP, or repository extension loading. */
export function buildExecutionServer(options: ExecutionServerOptions) {
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024 });
  const env = new NodeExecutionEnv({ cwd: options.cwd });
  const readers = new Map<string, TextLineReader>();
  const calls = new Map<string, { controller: AbortController; done: Promise<void> }>();
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/v1/health") return;
    const received = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
      return reply.code(401).send(failure("permission_denied", "invalid execution token"));
    // The retained local CLI authenticates with the incarnation-scoped runtime token.
    if (request.url === RUNTIME_ALERT_PATH) return;
    if (request.headers["x-orb-incarnation"] !== options.incarnation)
      return reply.code(409).send(failure("invalid", "stale execution incarnation"));
    if (options.ready && !options.ready()) {
      const health = options.health?.();
      if (
        request.url === EXECUTION_READY_PATH &&
        Check(RuntimeHealthSchema, health) &&
        (health.status === "failed" || health.status === "initializing")
      )
        return reply.code(503).send(health);
      return reply.code(503).send(failure("invalid", "execution host not ready"));
    }
  });
  app.get("/v1/health", async () => options.health?.() ?? { status: "ready" });
  app.post(RUNTIME_ALERT_PATH, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    if (!Check(RuntimeAlertRequestSchema, request.body) || !request.body.message.trim())
      return reply.code(400).send(failure("invalid", "invalid alert"));
    if (!options.appendAlert)
      return reply.code(503).send(failure("unavailable", "alert admission unavailable"));
    const result = await options.appendAlert(request.body);
    return result.isOk()
      ? result.value
      : reply
          .code(result.error.code === "conflict" ? 409 : 503)
          .send(failure(result.error.code, result.error.message));
  });
  app.get(
    EXECUTION_READY_PATH,
    async () =>
      options.ready?.() ?? {
        cwd: options.cwd,
        incarnation: options.incarnation,
        pid: process.pid,
        checkoutCommit: "",
        instructions: [],
        skills: [],
        resources: [],
      },
  );
  app.post(EXECUTION_RPC_PATH, async (request, reply) => {
    if (!Check(ExecutionRpcSchema, request.body))
      return reply.code(400).send(failure("invalid", "invalid execution request"));
    const { operation, args, cwd } = request.body;
    const context = executionContext();
    // Cwd belongs to this invocation, never shared mutable state across calls.
    const callEnv = new NodeExecutionEnv({ cwd });
    try {
      if (operation === "readerRead" || operation === "readerClose") {
        const id = String(args[0]);
        const reader = readers.get(id);
        if (!reader) return failure("invalid", "unknown line reader");
        if (operation === "readerClose") {
          readers.delete(id);
          await reader.close(context);
          return { ok: true };
        }
        return wire(await reader.readLine(context));
      }
      if (operation === "openTextLineReader") {
        if (readers.size >= 128) return failure("invalid", "too many open readers");
        const path = await callEnv.absolutePath(String(args[0]), context);
        if (!path.ok) return wire(path);
        const result = await BoundedLineReader.open(path.value);
        if (!result.ok) return wire(result);
        const id = randomUUID();
        readers.set(id, result.value);
        return { ok: true, value: id };
      }
      if (operation === "readTextLines") {
        const path = await callEnv.absolutePath(String(args[0]), context);
        if (!path.ok) return wire(path);
        const opened = await BoundedLineReader.open(path.value);
        if (!opened.ok) return wire(opened);
        const hasLimit =
          args[1] &&
          typeof args[1] === "object" &&
          "maxLines" in args[1] &&
          args[1].maxLines !== undefined;
        const requested = hasLimit ? Number((args[1] as { maxLines: unknown }).maxLines) : 2048;
        if (!Number.isSafeInteger(requested) || requested < 0 || requested > 2048) {
          await opened.value.close(context);
          return failure("invalid", "line count must be between 0 and 2048");
        }
        const lines: string[] = [];
        let bytes = 0;
        try {
          while (lines.length < requested) {
            const line = await opened.value.readLine(context);
            if (!line.ok) return wire(line);
            if (!line.value) break;
            bytes += Buffer.byteLength(line.value.text);
            if (bytes > 1024 * 1024) return failure("invalid", "line response exceeds 1 MiB");
            lines.push(line.value.text);
          }
          if (!hasLimit && lines.length === 2048) {
            const next = await opened.value.readLine(context);
            if (!next.ok) return wire(next);
            if (next.value)
              return failure(
                "invalid",
                "unbounded line read exceeds 2048 lines; use a line reader",
              );
          }
          return { ok: true, value: lines };
        } finally {
          await opened.value.close(context);
        }
      }
      if (operation === "readTextFile" || operation === "readBinaryFile") {
        const path = await callEnv.canonicalPath(String(args[0]), context);
        if (!path.ok) return wire(path);
        const info = await callEnv.fileInfo(path.value, context);
        if (!info.ok) return wire(info);
        if (info.value.size > 16 * 1024 * 1024)
          return failure(
            "invalid",
            "whole-file reads are limited to 16 MiB; use line readers or shell",
          );
      }
      if (
        (operation === "writeFile" || operation === "appendFile") &&
        typeof args[1] === "object" &&
        args[1] !== null &&
        "binary" in args[1]
      )
        args[1] = Buffer.from(String(args[1].binary), "base64");
      // The wire enum is the capability allowlist; neither exec nor arbitrary object members are callable here.
      const method = callEnv[operation as keyof NodeExecutionEnv];
      if (typeof method !== "function" || ["exec", "cleanup", "constructor"].includes(operation))
        return failure("invalid", "unknown operation");
      const invoke = method.bind(callEnv) as (
        ...args: unknown[]
      ) => Promise<Parameters<typeof wire>[0]>;
      return wire(await invoke(...args, context));
    } catch {
      return failure("invalid", "invalid filesystem operation");
    }
  });
  app.post(EXECUTION_CANCEL_PATH, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string")
      return reply.code(400).send(failure("invalid", "invalid cancellation request"));
    const call = calls.get(body.id);
    if (call) {
      call.controller.abort();
      await call.done;
    }
    return { ok: true };
  });
  app.post(EXECUTION_EXEC_PATH, async (request, reply) => {
    if (!Check(ExecutionExecSchema, request.body))
      return reply.code(400).send(failure("invalid", "invalid execution command"));
    const id = request.body.id;
    if (calls.has(id)) return reply.code(409).send(failure("invalid", "duplicate execution ID"));
    const call = new AbortController();
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    calls.set(id, { controller: call, done });
    const cancel = () => call.abort();
    reply.raw.on("close", cancel);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson" });
    reply.raw.flushHeaders();
    const callEnv = new NodeExecutionEnv({ cwd: request.body.cwd });
    const result = await callEnv.exec(
      request.body.command,
      {
        ...request.body.options,
        onOutput: (text) => {
          if (!reply.raw.destroyed) {
            reply.raw.write(`${JSON.stringify({ type: "output", text })}\n`);
            // Slow clients must not cause unbounded host buffering.
            if (reply.raw.writableLength > 1024 * 1024) call.abort();
          }
        },
      },
      executionContext(call.signal),
    );
    calls.delete(id);
    settled();
    reply.raw.off("close", cancel);
    if (!reply.raw.destroyed)
      reply.raw.end(`${JSON.stringify({ type: "result", result: wire(result) })}\n`);
  });
  app.addHook("preClose", async () => {
    for (const call of calls.values()) call.controller.abort();
    await Promise.all([...calls.values()].map((call) => call.done));
  });
  app.addHook("onClose", async () => {
    for (const reader of readers.values()) await reader.close(executionContext());
    readers.clear();
    await env.cleanup(executionContext());
  });
  return app;
}
