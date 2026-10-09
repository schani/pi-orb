import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  type Result as EnvResult,
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileInfo,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { err, type Result, type ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "../../domain/errors.ts";

export interface LazyExecutionOptions {
  readonly cwd: string;
  readonly id?: string;
  readonly acquire: (
    context: Context,
    waiting?: () => ResultAsync<void, RuntimeClientError>,
  ) => ResultAsync<ExecutionEnv, RuntimeClientError>;
  readonly admit?: () => Result<void, RuntimeClientError>;
  readonly validate?: (
    env: ExecutionEnv,
    context: Context,
  ) => ResultAsync<void, RuntimeClientError>;
}

/** One immutable binding per invocation; construction never waits for compute. */
export class LazyExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly options: LazyExecutionOptions;
  private readonly abort = new AbortController();
  private binding: Promise<Result<ExecutionEnv, RuntimeClientError>> | undefined;
  private bound: ExecutionEnv | undefined;
  private readonly invocations = new Set<LazyExecutionEnv>();
  private release = () => {};
  private retain = () => {};
  private cleanupPromise: Promise<void> | undefined;
  private waiting:
    | ((
        phase: "waiting" | "ready" | "failed" | "cancelled",
      ) => ResultAsync<void, RuntimeClientError>)
    | undefined;
  private waitingObserved = false;
  private rejectionReported = false;
  attempted(): boolean {
    return this.binding !== undefined;
  }
  private async reject(
    error: RuntimeClientError,
  ): Promise<Result<ExecutionEnv, RuntimeClientError>> {
    if (!this.rejectionReported) {
      this.rejectionReported = true;
      await this.waiting?.(error.code === "cancelled" ? "cancelled" : "failed");
    }
    return err(error);
  }
  observeWait(
    waiting: (
      phase: "waiting" | "ready" | "failed" | "cancelled",
    ) => ResultAsync<void, RuntimeClientError>,
  ): void {
    this.waiting = waiting;
  }
  constructor(options: LazyExecutionOptions) {
    this.options = options;
    this.id = options.id ?? randomUUID();
    this.cwd = options.cwd;
  }
  invocation(admit?: LazyExecutionOptions["admit"]): LazyExecutionEnv {
    const child = new LazyExecutionEnv({
      ...this.options,
      cwd: this.cwd,
      id: this.id,
      ...(admit ? { admit } : {}),
    });
    child.retain = () => {
      if (this.abort.signal.aborted) child.abort.abort();
      else this.invocations.add(child);
    };
    child.release = () => this.invocations.delete(child);
    return child;
  }
  retainedInvocations(): number {
    return this.invocations.size;
  }
  active(): boolean {
    return this.bound !== undefined || [...this.invocations].some((child) => child.active());
  }
  private async acquire(context: Context): Promise<Result<ExecutionEnv, RuntimeClientError>> {
    const signal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, this.abort.signal])
      : this.abort.signal;
    if (signal.aborted) return err(this.cancelled());
    this.retain();
    if (signal.aborted) return err(this.cancelled());
    const waiting = this.waiting;
    this.binding ??= Promise.resolve(
      this.options.acquire(
        withAbortSignal(signal, context),
        waiting
          ? () => {
              this.waitingObserved = true;
              return waiting("waiting");
            }
          : undefined,
      ),
    );
    const acquired = await this.binding;
    if (this.waitingObserved) {
      this.waitingObserved = false;
      if (!signal.aborted && acquired.isOk()) {
        const published = await this.waiting?.("ready");
        if (published?.isErr()) return this.reject(published.error);
      }
    }
    if (signal.aborted) return this.reject(this.cancelled());
    if (acquired.isErr()) return this.reject(acquired.error);
    this.bound = acquired.value;
    this.cwd = acquired.value.cwd;
    const admitted = this.options.admit?.();
    if (admitted?.isErr()) return this.reject(admitted.error);
    const validated = await this.options.validate?.(
      acquired.value,
      withAbortSignal(signal, context),
    );
    if (signal.aborted) return this.reject(this.cancelled());
    return validated?.isErr() ? this.reject(validated.error) : acquired;
  }
  private cancelled(): RuntimeClientError {
    return {
      type: "runtime_client_error",
      code: "cancelled",
      answered: true,
      retryable: false,
      message: "execution wait cancelled",
    };
  }
  private invocationContext(context: Context): Context {
    return withAbortSignal(
      context.abortSignal
        ? AbortSignal.any([context.abortSignal, this.abort.signal])
        : this.abort.signal,
      context,
    );
  }
  private async file<T>(
    context: Context,
    call: (env: ExecutionEnv, invocation: Context) => Promise<EnvResult<T, FileError>>,
  ): Promise<EnvResult<T, FileError>> {
    const invocation = this.invocationContext(context);
    let acquired = await this.acquire(invocation);
    if (invocation.abortSignal?.aborted) acquired = err(this.cancelled());
    return acquired.isErr()
      ? {
          ok: false,
          error: new FileError(
            acquired.error.code === "cancelled" ? "aborted" : "unknown",
            acquired.error.message,
          ),
        }
      : call(acquired.value, invocation);
  }
  absolutePath(path: string, context: Context): Promise<EnvResult<string, FileError>> {
    return this.file(context, (env, invocation) => env.absolutePath(path, invocation));
  }
  joinPath(parts: string[], context: Context): Promise<EnvResult<string, FileError>> {
    return this.file(context, (env, invocation) => env.joinPath(parts, invocation));
  }
  readTextFile(path: string, context: Context): Promise<EnvResult<string, FileError>> {
    return this.file(context, (env, invocation) => env.readTextFile(path, invocation));
  }
  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<EnvResult<string[], FileError>> {
    return this.file(context, (env, invocation) => env.readTextLines(path, options, invocation));
  }
  readBinaryFile(path: string, context: Context): Promise<EnvResult<Uint8Array, FileError>> {
    return this.file(context, (env, invocation) => env.readBinaryFile(path, invocation));
  }
  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.writeFile(path, content, invocation));
  }
  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.appendFile(path, content, invocation));
  }
  truncateFile(path: string, size: number, context: Context): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.truncateFile(path, size, invocation));
  }
  flushFile(path: string, context: Context): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.flushFile(path, invocation));
  }
  renameFile(
    source: string,
    destination: string,
    context: Context,
  ): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.renameFile(source, destination, invocation));
  }
  fileInfo(path: string, context: Context): Promise<EnvResult<FileInfo, FileError>> {
    return this.file(context, (env, invocation) => env.fileInfo(path, invocation));
  }
  listDir(path: string, context: Context): Promise<EnvResult<FileInfo[], FileError>> {
    return this.file(context, (env, invocation) => env.listDir(path, invocation));
  }
  canonicalPath(path: string, context: Context): Promise<EnvResult<string, FileError>> {
    return this.file(context, (env, invocation) => env.canonicalPath(path, invocation));
  }
  exists(path: string, context: Context): Promise<EnvResult<boolean, FileError>> {
    return this.file(context, (env, invocation) => env.exists(path, invocation));
  }
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.createDir(path, options, invocation));
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<EnvResult<void, FileError>> {
    return this.file(context, (env, invocation) => env.remove(path, options, invocation));
  }
  createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<EnvResult<string, FileError>> {
    return this.file(context, (env, invocation) => env.createTempDir(prefix, invocation));
  }
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<EnvResult<string, FileError>> {
    return this.file(context, (env, invocation) => env.createTempFile(options, invocation));
  }
  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<EnvResult<TextLineReader, FileError>> {
    const result = await this.file(context, (env, invocation) =>
      env.openTextLineReader(path, invocation),
    );
    if (!result.ok) return result;
    const reader = result.value;
    return {
      ok: true,
      value: {
        readLine: (ctx) => this.file(ctx, (_env, invocation) => reader.readLine(invocation)),
        close: (ctx) => reader.close(ctx),
      },
    };
  }
  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<EnvResult<ShellExecResult, ExecutionError>> {
    const invocation = this.invocationContext(context);
    let acquired = await this.acquire(invocation);
    if (invocation.abortSignal?.aborted) acquired = err(this.cancelled());
    return acquired.isErr()
      ? {
          ok: false,
          error: new ExecutionError(
            acquired.error.code === "cancelled" ? "aborted" : "unknown",
            acquired.error.message,
          ),
        }
      : acquired.value.exec(
          command,
          options?.cwd === "" ? { ...options, cwd: acquired.value.cwd } : options,
          invocation,
        );
  }
  cleanup(context: Context): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.abort.abort();
    this.cleanupPromise = (async () => {
      await Promise.all([...this.invocations].map((child) => child.cleanup(context)));
      this.invocations.clear();
      const acquired = await this.binding;
      const bound = this.bound ?? (acquired?.isOk() ? acquired.value : undefined);
      await bound?.cleanup(context);
      this.bound = undefined;
      this.release();
    })();
    return this.cleanupPromise;
  }
}
