import { randomUUID } from "node:crypto";
import { errAsync, okAsync, Result, ResultAsync, type Result as ResultType } from "neverthrow";
import type { IPty } from "node-pty";

export interface TerminalManagerError {
  readonly code: "limit_reached" | "pty_unavailable" | "pty_failed";
  readonly message: string;
  readonly retryable: boolean;
}

export interface TerminalProcessExit {
  readonly exitCode: number;
  readonly signal: number;
}

/** Immediate adapter port around a platform PTY implementation. */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: TerminalProcessExit) => void): () => void;
}

export interface PtyFactory {
  open(
    cwd: string,
    cols: number,
    rows: number,
    environment: Readonly<Record<string, string>>,
  ): ResultAsync<PtyProcess, TerminalManagerError>;
}

class NodePtyProcess implements PtyProcess {
  private readonly process: IPty;
  constructor(process: IPty) {
    this.process = process;
  }
  write(data: string): void {
    this.process.write(data);
  }
  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }
  kill(): void {
    this.process.kill();
  }
  onData(listener: (data: string) => void): () => void {
    const disposable = this.process.onData(listener);
    return () => disposable.dispose();
  }
  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    const disposable = this.process.onExit((exit) =>
      listener({ exitCode: exit.exitCode, signal: exit.signal ?? 0 }),
    );
    return () => disposable.dispose();
  }
}

export class NodePtyFactory implements PtyFactory {
  open(
    cwd: string,
    cols: number,
    rows: number,
    environment: Readonly<Record<string, string>>,
  ): ResultAsync<PtyProcess, TerminalManagerError> {
    return ResultAsync.fromPromise(
      import("node-pty"),
      (cause): TerminalManagerError => ({
        code: "pty_unavailable",
        message: `terminal PTY binding is unavailable: ${String(cause)}`,
        retryable: false,
      }),
    ).andThen((pty) =>
      Result.fromThrowable(
        () =>
          new NodePtyProcess(
            pty.spawn("/bin/bash", ["--noprofile", "--norc"], {
              name: "xterm-256color",
              cols,
              rows,
              cwd,
              env: {
                ...environment,
                TERM: "xterm-256color",
                COLORTERM: "truecolor",
                PS1: "# ",
              },
            }),
          ),
        (cause): TerminalManagerError => ({
          code: "pty_failed",
          message: `could not start terminal: ${String(cause)}`,
          retryable: true,
        }),
      )(),
    );
  }
}

export class ManagedTerminal {
  readonly id: string;
  private readonly process: PtyProcess;
  constructor(id: string, process: PtyProcess) {
    this.id = id;
    this.process = process;
  }

  write(data: string): ResultType<void, TerminalManagerError> {
    return this.call(() => this.process.write(data), "write to terminal");
  }

  resize(cols: number, rows: number): ResultType<void, TerminalManagerError> {
    return this.call(() => this.process.resize(cols, rows), "resize terminal");
  }

  close(): ResultType<void, TerminalManagerError> {
    return this.call(() => this.process.kill(), "close terminal");
  }

  onData(listener: (data: string) => void): ResultType<() => void, TerminalManagerError> {
    return this.subscribe(() => this.process.onData(listener), "subscribe to terminal output");
  }

  onExit(
    listener: (exit: TerminalProcessExit) => void,
  ): ResultType<() => void, TerminalManagerError> {
    return this.subscribe(() => this.process.onExit(listener), "subscribe to terminal exit");
  }

  private subscribe(
    action: () => () => void,
    operation: string,
  ): ResultType<() => void, TerminalManagerError> {
    return Result.fromThrowable(
      action,
      (cause): TerminalManagerError => ({
        code: "pty_failed",
        message: `${operation} failed: ${String(cause)}`,
        retryable: true,
      }),
    )();
  }

  private call(action: () => void, operation: string): ResultType<void, TerminalManagerError> {
    return Result.fromThrowable(
      action,
      (cause): TerminalManagerError => ({
        code: "pty_failed",
        message: `${operation} failed: ${String(cause)}`,
        retryable: true,
      }),
    )();
  }
}

export interface TerminalManagerOptions {
  readonly cwd: string;
  readonly maxSessions?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly factory?: PtyFactory;
}

/** Runtime-wide admission and cleanup for ephemeral, per-WebSocket PTYs. */
export class TerminalManager {
  private readonly options: TerminalManagerOptions;
  private readonly maxSessions: number;
  private readonly factory: PtyFactory;
  private readonly environment: Readonly<Record<string, string>> | null;
  private readonly active = new Map<string, ManagedTerminal | null>();
  private closing = false;

  constructor(options: TerminalManagerOptions) {
    this.options = options;
    this.maxSessions = options.maxSessions ?? 4;
    this.factory = options.factory ?? new NodePtyFactory();
    this.environment = options.environment ?? null;
  }

  get activeCount(): number {
    return this.active.size;
  }

  open(cols: number, rows: number): ResultAsync<ManagedTerminal, TerminalManagerError> {
    if (this.closing) {
      return errAsync({
        code: "pty_unavailable",
        message: "terminal manager is shutting down",
        retryable: true,
      });
    }
    if (this.active.size >= this.maxSessions) {
      return errAsync({
        code: "limit_reached",
        message: `at most ${this.maxSessions} terminal sessions may be open`,
        retryable: true,
      });
    }

    // Reserve synchronously before crossing the async native-module boundary.
    const id = randomUUID();
    this.active.set(id, null);
    // Read per PTY, not once at construction: the manager is installed before
    // the boot hooks run, and their env file is merged into `process.env`
    // afterwards (docs/orb-setup-hook.md).
    return this.factory
      .open(this.options.cwd, cols, rows, this.environment ?? cleanEnvironment(process.env))
      .andThen((process) => {
        if (this.closing) {
          Result.fromThrowable(
            () => process.kill(),
            () => undefined,
          )();
          this.active.delete(id);
          return errAsync<ManagedTerminal, TerminalManagerError>({
            code: "pty_unavailable",
            message: "terminal manager is shutting down",
            retryable: true,
          });
        }
        const terminal = new ManagedTerminal(id, process);
        const release = terminal.onExit(() => this.active.delete(id));
        if (release.isErr()) {
          terminal.close();
          this.active.delete(id);
          return errAsync<ManagedTerminal, TerminalManagerError>(release.error);
        }
        this.active.set(id, terminal);
        return okAsync<ManagedTerminal, TerminalManagerError>(terminal);
      })
      .orElse((error) => {
        this.active.delete(id);
        return errAsync(error);
      });
  }

  closeAll(): void {
    if (this.closing) return;
    this.closing = true;
    for (const terminal of this.active.values()) terminal?.close();
    this.active.clear();
  }
}

function cleanEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) clean[name] = value;
  }
  return clean;
}
