import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  type Result as EnvResult,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import {
  EXECUTION_CANCEL_PATH,
  EXECUTION_EXEC_PATH,
  EXECUTION_READY_PATH,
  EXECUTION_RPC_PATH,
  type ExecutionReady,
  ExecutionReadySchema,
  ExecutionStreamFrameSchema,
  type ExecutionWireResult,
  ExecutionWireResultSchema,
  type RuntimeHealth,
  RuntimeHealthSchema,
} from "@pi-orb/protocol";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { Check } from "typebox/value";

export interface RemoteExecutionOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly incarnation: string;
  readonly cwd: string;
  readonly id?: string;
}
export interface ExecutionTransportError {
  readonly type: "execution_transport_error";
  readonly code: "aborted" | "unavailable" | "invalid_response" | "initialization_failed";
  readonly message: string;
  readonly initializationError?: Extract<RuntimeHealth, { status: "failed" }>["error"];
  readonly initializationHealth?: Extract<RuntimeHealth, { status: "initializing" }>;
}
/** Durable's Result contract is converted only at this adapter's outer boundary. */
export class RemoteExecutionEnv implements ExecutionEnv {
  readonly baseUrl: string;
  readonly incarnation: string;
  readonly id: string;
  cwd: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly readers = new Set<string>();
  private readonly activeCancels = new Set<() => Promise<void>>();
  constructor(options: RemoteExecutionOptions) {
    this.baseUrl = options.baseUrl;
    this.incarnation = options.incarnation;
    this.cwd = options.cwd;
    this.id = options.id ?? `${options.baseUrl}#${options.incarnation}`;
    this.headers = Object.freeze({
      authorization: `Bearer ${options.token}`,
      "x-orb-incarnation": options.incarnation,
      "content-type": "application/json",
    });
  }
  private async request(
    path: string,
    body: unknown,
    context: Context,
  ): Promise<Result<ExecutionWireResult, ExecutionTransportError>> {
    const headers = this.headers;
    const result = await ResultAsync.fromPromise(
      (async () => {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: context.abortSignal ?? null,
        });
        return (await response.json()) as unknown;
      })(),
      (): ExecutionTransportError => ({
        type: "execution_transport_error",
        code: context.abortSignal?.aborted ? "aborted" : "unavailable",
        message: "execution RPC unavailable",
      }),
    );
    if (result.isErr()) return err(result.error);
    return Check(ExecutionWireResultSchema, result.value)
      ? ok(result.value)
      : err({
          type: "execution_transport_error",
          code: "invalid_response",
          message: "invalid execution RPC response",
        });
  }
  async ready(context: Context): Promise<Result<ExecutionReady, ExecutionTransportError>> {
    return ResultAsync.fromPromise(
      (async () => {
        const response = await fetch(`${this.baseUrl}${EXECUTION_READY_PATH}`, {
          headers: this.headers,
          signal: context.abortSignal ?? null,
        });
        const payload: unknown = await response.json();
        if (
          response.status === 503 &&
          Check(RuntimeHealthSchema, payload) &&
          payload.status === "failed"
        )
          return err<ExecutionReady, ExecutionTransportError>({
            type: "execution_transport_error",
            code: "initialization_failed",
            message: payload.error.message,
            initializationError: payload.error,
          });
        if (
          response.status === 503 &&
          Check(RuntimeHealthSchema, payload) &&
          payload.status === "initializing"
        )
          return err<ExecutionReady, ExecutionTransportError>({
            type: "execution_transport_error",
            code: "unavailable",
            message: "execution initializing",
            initializationHealth: payload,
          });
        if (!response.ok)
          return err<ExecutionReady, ExecutionTransportError>({
            type: "execution_transport_error",
            code: "unavailable",
            message: `execution readiness HTTP ${response.status}`,
          });
        if (!Check(ExecutionReadySchema, payload))
          return err<ExecutionReady, ExecutionTransportError>({
            type: "execution_transport_error",
            code: "invalid_response",
            message: "invalid execution readiness response",
          });
        return ok<ExecutionReady, ExecutionTransportError>(payload);
      })(),
      (): ExecutionTransportError => ({
        type: "execution_transport_error",
        code: "unavailable",
        message: "execution readiness unavailable",
      }),
    ).andThen((value) => value);
  }
  private async rpc<T>(
    operation: string,
    args: unknown[],
    context: Context,
  ): Promise<EnvResult<T, FileError>> {
    const response = await this.request(
      EXECUTION_RPC_PATH,
      { operation, args, cwd: this.cwd },
      context,
    );
    if (response.isErr())
      return {
        ok: false,
        error: new FileError(
          response.error.code === "aborted" ? "aborted" : "unknown",
          response.error.message,
        ),
      };
    const result = response.value;
    if (!result.ok)
      return {
        ok: false,
        error: new FileError(
          result.error.code as FileError["code"],
          result.error.message,
          result.error.path,
        ),
      };
    return { ok: true, value: result.value as T };
  }
  absolutePath(path: string, context: Context) {
    return this.rpc<string>("absolutePath", [path], context);
  }
  joinPath(parts: string[], context: Context) {
    return this.rpc<string>("joinPath", [parts], context);
  }
  readTextFile(path: string, context: Context) {
    return this.rpc<string>("readTextFile", [path], context);
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.rpc<string[]>("readTextLines", [path, options], context);
  }
  async readBinaryFile(path: string, context: Context): Promise<EnvResult<Uint8Array, FileError>> {
    const result = await this.rpc<{ binary: string }>("readBinaryFile", [path], context);
    return result.ok
      ? { ok: true, value: new Uint8Array(Buffer.from(result.value.binary, "base64")) }
      : result;
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.rpc<void>(
      "writeFile",
      [
        path,
        typeof content === "string" ? content : { binary: Buffer.from(content).toString("base64") },
      ],
      context,
    );
  }
  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.rpc<void>(
      "appendFile",
      [
        path,
        typeof content === "string" ? content : { binary: Buffer.from(content).toString("base64") },
      ],
      context,
    );
  }
  truncateFile(path: string, size: number, context: Context) {
    return this.rpc<void>("truncateFile", [path, size], context);
  }
  flushFile(path: string, context: Context) {
    return this.rpc<void>("flushFile", [path], context);
  }
  renameFile(source: string, destination: string, context: Context) {
    return this.rpc<void>("renameFile", [source, destination], context);
  }
  fileInfo(path: string, context: Context) {
    return this.rpc<FileInfo>("fileInfo", [path], context);
  }
  listDir(path: string, context: Context) {
    return this.rpc<FileInfo[]>("listDir", [path], context);
  }
  canonicalPath(path: string, context: Context) {
    return this.rpc<string>("canonicalPath", [path], context);
  }
  exists(path: string, context: Context) {
    return this.rpc<boolean>("exists", [path], context);
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.rpc<void>("createDir", [path, options], context);
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return this.rpc<void>("remove", [path, options], context);
  }
  createTempDir(prefix: string | undefined, context: Context) {
    return this.rpc<string>("createTempDir", [prefix], context);
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.rpc<string>("createTempFile", [options], context);
  }
  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<EnvResult<TextLineReader, FileError>> {
    const result = await this.rpc<string>("openTextLineReader", [path], context);
    if (!result.ok) return result;
    const id = result.value;
    this.readers.add(id);
    return {
      ok: true,
      value: {
        readLine: (ctx) => this.rpc<TextLine | undefined>("readerRead", [id], ctx),
        close: async (ctx) => {
          this.readers.delete(id);
          await this.rpc<void>("readerClose", [id], this.releaseContext(ctx));
        },
      },
    };
  }
  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<EnvResult<ShellExecResult, ExecutionError>> {
    const controller = new AbortController();
    if (context.abortSignal?.aborted)
      return {
        ok: false,
        error: new ExecutionError("aborted", "execution aborted before admission"),
      };
    const signal = controller.signal;
    const headers = this.headers;
    const cwd = this.cwd;
    const id = randomUUID();
    let cancelRequest: Promise<void> | undefined;
    let cancellationFailed = false;
    let admitted = false;
    let terminal = false;
    const admissionTimeout = setTimeout(() => controller.abort(), 10_000);
    const cancel = () => {
      cancelRequest ??= (async () => {
        const cancelled = await ResultAsync.fromPromise(
          fetch(`${this.baseUrl}${EXECUTION_CANCEL_PATH}`, {
            method: "POST",
            headers,
            body: JSON.stringify({ id }),
            signal: AbortSignal.timeout(10_000),
          }).then((response) => {
            if (!response.ok) {
              cancellationFailed = true;
              controller.abort();
            }
          }),
          () => "remote cancellation unavailable",
        );
        if (cancelled.isErr()) {
          cancellationFailed = true;
          controller.abort();
        }
      })();
    };
    const stop = async () => {
      cancel();
      await cancelRequest;
    };
    const result = await ResultAsync.fromPromise(
      (async (): Promise<EnvResult<ShellExecResult, ExecutionError>> => {
        const { onOutput, ...wireOptions } = options ?? {};
        const response = await fetch(`${this.baseUrl}${EXECUTION_EXEC_PATH}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id, command, cwd, options: wireOptions }),
          signal,
        });
        clearTimeout(admissionTimeout);
        this.activeCancels.add(stop);
        // Headers confirm admission before a cancellation request can be sent.
        context.abortSignal?.addEventListener("abort", cancel, { once: true });
        if (context.abortSignal?.aborted) cancel();
        if (!response.ok || !response.body)
          return {
            ok: false,
            error: new ExecutionError("unknown", `execution HTTP ${response.status}`),
          };
        admitted = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            pending += decoder.decode(next.value, { stream: true });
            let end = pending.indexOf("\n");
            while (end >= 0) {
              if (end > 1024 * 1024)
                return {
                  ok: false,
                  error: new ExecutionError("unknown", "oversized execution frame"),
                };
              const frame: unknown = JSON.parse(pending.slice(0, end));
              if (!Check(ExecutionStreamFrameSchema, frame))
                return {
                  ok: false,
                  error: new ExecutionError("unknown", "invalid execution stream frame"),
                };
              pending = pending.slice(end + 1);
              if (frame.type === "output") {
                const emitted = Result.fromThrowable(
                  () => onOutput?.(frame.text, context),
                  () => new ExecutionError("callback_error", "execution output callback failed"),
                )();
                if (emitted.isErr()) {
                  cancel();
                  await cancelRequest;
                  return { ok: false, error: emitted.error };
                }
              } else {
                terminal = true;
                if (frame.result.ok)
                  return { ok: true, value: frame.result.value as ShellExecResult };
                const error = new ExecutionError(
                  frame.result.error.code as ExecutionError["code"],
                  frame.result.error.message,
                );
                if (frame.result.error.spillPath !== undefined)
                  error.spillPath = frame.result.error.spillPath;
                return { ok: false, error };
              }
              end = pending.indexOf("\n");
            }
            if (pending.length > 1024 * 1024)
              return {
                ok: false,
                error: new ExecutionError("unknown", "oversized execution frame"),
              };
          }
          return {
            ok: false,
            error: new ExecutionError(
              "unknown",
              "execution stream interrupted; effects may have occurred",
            ),
          };
        } finally {
          await reader.cancel();
        }
      })(),
      (): ExecutionError =>
        new ExecutionError(
          "unknown",
          cancellationFailed
            ? "execution cancellation not confirmed; effects may have occurred"
            : "execution transport failed; effects may have occurred",
        ),
    );
    clearTimeout(admissionTimeout);
    if (admitted && !terminal) await stop();
    this.activeCancels.delete(stop);
    context.abortSignal?.removeEventListener("abort", cancel);
    await cancelRequest;
    controller.abort();
    if (cancellationFailed)
      return {
        ok: false,
        error: new ExecutionError(
          "unknown",
          "execution cancellation not confirmed; effects may have occurred",
        ),
      };
    return result.isOk() ? result.value : { ok: false, error: result.error };
  }
  private releaseContext(context: Context): Context {
    return {
      abortSignal: AbortSignal.timeout(10_000),
      value: (key) => context.value(key),
      toString: () => context.toString(),
    };
  }
  async cleanup(context: Context): Promise<void> {
    await Promise.all([...this.activeCancels].map((cancel) => cancel()));
    const release = this.releaseContext(context);
    const ids = [...this.readers];
    this.readers.clear();
    await Promise.all(ids.map((id) => this.rpc<void>("readerClose", [id], release)));
  }
}
