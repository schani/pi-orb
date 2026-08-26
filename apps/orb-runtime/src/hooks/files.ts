import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, Result, type ResultAsync } from "neverthrow";
import type { HookFileError, HookFileStore } from "./ports.ts";

const toFileError = (error: unknown): HookFileError => ({
  type: "hook_file_error",
  message: error instanceof Error ? error.message : String(error),
});

const settle = (done: Result<void, HookFileError>): ResultAsync<void, HookFileError> =>
  done.isErr() ? errAsync(done.error) : okAsync(undefined);

/** The real disk behind `HookFileStore`; the task belongs to the port, not to it. */
export class NodeHookFileStore implements HookFileStore {
  readText(path: string): string | null {
    return Result.fromThrowable(
      () => readFileSync(path, "utf8"),
      () => undefined,
    )().unwrapOr(null);
  }

  ensureDir(path: string): Result<void, HookFileError> {
    return Result.fromThrowable(() => {
      mkdirSync(path, { recursive: true });
    }, toFileError)();
  }

  writeText(
    _task: SimulationTask,
    path: string,
    contents: string,
  ): ResultAsync<void, HookFileError> {
    return settle(
      Result.fromThrowable(() => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
      }, toFileError)(),
    );
  }

  remove(path: string): void {
    Result.fromThrowable(
      () => rmSync(path, { force: true }),
      () => undefined,
    )();
  }

  hardenFile(path: string): void {
    Result.fromThrowable(
      () => chmodSync(path, 0o600),
      () => undefined,
    )();
  }
}
