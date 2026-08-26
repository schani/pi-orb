import type { SimulationTask } from "determined";
import type { Result, ResultAsync } from "neverthrow";

/** The two repository-owned boot hooks (`docs/orb-setup-hook.md`). */
export type HookName = "setup" | "resume";

export interface HookSpawnRequest {
  /** Absolute path of the hook file; executed directly so its shebang decides the interpreter. */
  readonly executable: string;
  readonly cwd: string;
  /** Complete environment; the runtime's own is never merged in by the adapter. */
  readonly env: Readonly<Record<string, string>>;
  /** stdout and stderr are captured here, truncating the previous run's file. */
  readonly logPath: string;
  /** Mirrors every captured line to the runtime's log stream. */
  readonly onLine: (line: string) => void;
}

export interface HookProcessExit {
  /** Null when the process was terminated by a signal. */
  readonly code: number | null;
  readonly signal: string | null;
}

export interface HookProcess {
  /** Settles once the process has exited. Never rejects: a spawn failure is an exit too. */
  readonly exited: Promise<HookProcessExit>;
  /**
   * Terminates the hook's whole process group, so a script that backgrounded
   * children does not outlive its deadline. Idempotent and safe after exit.
   */
  killGroup(): void;
  /** The last captured output lines, oldest first, for the status file. */
  tail(): readonly string[];
}

export interface HookSpawnError {
  readonly type: "hook_spawn_error";
  readonly message: string;
}

/**
 * The runtime's only way to start a hook. Keeping it a port is what lets the
 * unit tests drive every outcome — exit codes, timeouts, process-group kills —
 * on a deterministic schedule (docs/testing.md).
 */
export interface HookSpawner {
  spawn(request: HookSpawnRequest): Result<HookProcess, HookSpawnError>;
}

export interface HookFileError {
  readonly type: "hook_file_error";
  readonly message: string;
}

/**
 * The two durable files a hook run leaves behind — the status beside the log
 * and the incarnation stamp on the workspace. It is a port for the same reason
 * the spawner is: a disk that refuses one of these writes is a schedule a
 * scenario has to be able to choose (docs/testing.md), and neither failure may
 * take the boot with it.
 */
export interface HookFileStore {
  /** File contents, or null when it is missing or unreadable. */
  readText(path: string): string | null;
  /**
   * Creates `path` and its parents. Synchronous on purpose: it runs before the
   * hook is spawned, and the spawn must stay in the same turn as the call that
   * asked for it.
   */
  ensureDir(path: string): Result<void, HookFileError>;
  /** Writes `path` in full, creating its parents and truncating what was there. */
  writeText(task: SimulationTask, path: string, contents: string): ResultAsync<void, HookFileError>;
  /** Removes `path`; a missing file is success. */
  remove(path: string): void;
}
