import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";

export interface IdleStopFenceError {
  readonly type: "idle_stop_fence_error";
  readonly message: string;
}
export interface IdleStopFence {
  read(): Result<string | null, IdleStopFenceError>;
  write(lifetimeId: string): Result<void, IdleStopFenceError>;
}

/** Independent of Pi's unflushed first-session buffer. Atomic across process death. */
export class FileIdleStopFence implements IdleStopFence {
  private readonly path: string;
  constructor(workDir: string) {
    this.path = join(workDir, ".idle-stop-fence");
  }
  read(): Result<string | null, IdleStopFenceError> {
    const loaded = Result.fromThrowable(
      () => readFileSync(this.path, "utf8"),
      (cause) => ({
        missing:
          typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT",
        message: String(cause),
      }),
    )();
    if (loaded.isErr())
      return loaded.error.missing
        ? ok(null)
        : err({ type: "idle_stop_fence_error", message: loaded.error.message });
    return loaded.value.trim() === ""
      ? err({ type: "idle_stop_fence_error", message: "empty idle-stop fence" })
      : ok(loaded.value.trim());
  }
  write(lifetimeId: string): Result<void, IdleStopFenceError> {
    const temporary = `${this.path}.${randomUUID()}.new`;
    const written = Result.fromThrowable(
      () => {
        writeFileSync(temporary, `${lifetimeId}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.path);
      },
      (cause): IdleStopFenceError => ({ type: "idle_stop_fence_error", message: String(cause) }),
    )();
    if (written.isErr()) {
      const cleanup = Result.fromThrowable(
        () => rmSync(temporary, { force: true }),
        (cause): IdleStopFenceError => ({
          type: "idle_stop_fence_error",
          message: `${written.error.message}; cleanup: ${String(cause)}`,
        }),
      )();
      if (cleanup.isErr()) return err(cleanup.error);
    }
    return written;
  }
}
