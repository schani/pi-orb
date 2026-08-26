import { ApplicationFailure, type SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type {
  HookFileError,
  HookFileStore,
  HookProcess,
  HookProcessExit,
  HookSpawnError,
  HookSpawner,
  HookSpawnRequest,
} from "../hooks/ports.ts";
import { HOOK_FAILPOINTS } from "./failpoints.ts";

export interface FakeHookRun {
  readonly request: HookSpawnRequest;
  /** Settle the hook with an exit code, as the real adapter would. */
  exit(code: number | null, signal?: string | null): void;
  /** Feed a line of output, mirroring the adapter's line splitting. */
  emit(line: string): void;
  killed: boolean;
}

/**
 * A spawner whose processes only exit when the test says so, so every timing
 * rule — the setup deadline, the resume blocking window, the process-group
 * kill — is decided by the scenario's schedule rather than by wall time.
 */
export class FakeHookSpawner implements HookSpawner {
  readonly runs: FakeHookRun[] = [];
  /** When set, the next spawn fails instead of starting a process. */
  spawnError: string | null = null;

  spawn(request: HookSpawnRequest): Result<HookProcess, HookSpawnError> {
    if (this.spawnError !== null) {
      const message = this.spawnError;
      this.spawnError = null;
      return err({ type: "hook_spawn_error", message });
    }
    const lines: string[] = [];
    let settle: ((exit: HookProcessExit) => void) | null = null;
    const exited = new Promise<HookProcessExit>((resolve) => {
      settle = resolve;
    });
    const run: FakeHookRun = {
      request,
      killed: false,
      emit: (line) => {
        lines.push(line);
        request.onLine(line);
      },
      exit: (code, signal = null) => settle?.({ code, signal }),
    };
    this.runs.push(run);
    return ok({
      exited,
      killGroup: () => {
        run.killed = true;
        settle?.({ code: null, signal: "SIGKILL" });
      },
      tail: () => [...lines],
    });
  }

  /** The single run of `hook`, asserted to exist. */
  runOf(hook: string): FakeHookRun {
    const run = this.runs.find((candidate) => candidate.request.executable.endsWith(`/${hook}`));
    if (run === undefined) throw new Error(`no ${hook} hook was spawned`);
    return run;
  }
}

/** Which durable artifact a path is, so failures can be aimed at one of them. */
const artifactOf = (path: string): "stamp" | "status" =>
  path.endsWith("setup-incarnation") ? "stamp" : "status";

/**
 * The persistent workspace and home as a map, with both durable writes behind
 * named failpoints. It survives a modeled runtime restart exactly as the disk
 * does: hand the same instance to the next `BootHookRunner`.
 */
export class FakeHookFileStore implements HookFileStore {
  private readonly files = new Map<string, string>();
  private stampWriteFailures = 0;
  private statusWriteFailures = 0;
  /** When set, the log directory cannot be created and no hook can run. */
  ensureDirError: string | null = null;

  /** Fail the next `count` writes of the incarnation stamp, deterministically. */
  failNextStampWrites(count: number): void {
    this.stampWriteFailures = count;
  }

  /** Fail the next `count` writes of a hook status file, deterministically. */
  failNextStatusWrites(count: number): void {
    this.statusWriteFailures = count;
  }

  readText(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  ensureDir(_path: string): Result<void, HookFileError> {
    return this.ensureDirError === null
      ? ok(undefined)
      : err({ type: "hook_file_error", message: this.ensureDirError });
  }

  writeText(
    task: SimulationTask,
    path: string,
    contents: string,
  ): ResultAsync<void, HookFileError> {
    const artifact = artifactOf(path);
    const run = async (): Promise<void> => {
      await task.failpoint(
        artifact === "stamp" ? HOOK_FAILPOINTS.stampWrite : HOOK_FAILPOINTS.statusWrite,
        path,
      );
      if (artifact === "stamp" && this.stampWriteFailures > 0) {
        this.stampWriteFailures -= 1;
        throw new ApplicationFailure("stamp write: scripted disk failure");
      }
      if (artifact === "status" && this.statusWriteFailures > 0) {
        this.statusWriteFailures -= 1;
        throw new ApplicationFailure("status write: scripted disk failure");
      }
      this.files.set(path, contents);
    };
    return ResultAsync.fromPromise(run(), (error): HookFileError => {
      if (error instanceof ApplicationFailure) {
        return { type: "hook_file_error", message: error.message };
      }
      return task.abortSimulation(error);
    });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  /** Every path that currently exists, for whole-disk assertions. */
  paths(): readonly string[] {
    return [...this.files.keys()].sort();
  }
}
