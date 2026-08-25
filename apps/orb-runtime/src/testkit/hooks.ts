import { err, ok, type Result } from "neverthrow";
import type {
  HookProcess,
  HookProcessExit,
  HookSpawnError,
  HookSpawner,
  HookSpawnRequest,
} from "../hooks/ports.ts";

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
