import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Result } from "neverthrow";
import type {
  HookProcess,
  HookProcessExit,
  HookSpawnError,
  HookSpawner,
  HookSpawnRequest,
} from "./ports.ts";
import { STATUS_TAIL_LINES } from "./runner.ts";

/**
 * Splits a stream into lines for the log mirror and the status tail. Bytes
 * still reach the log file verbatim; this only decides where a line ends.
 */
class LineSplitter {
  private pending = "";
  private readonly emit: (line: string) => void;

  constructor(emit: (line: string) => void) {
    this.emit = emit;
  }

  push(chunk: string): void {
    this.pending += chunk;
    let index = this.pending.indexOf("\n");
    while (index >= 0) {
      this.emit(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf("\n");
    }
  }

  flush(): void {
    if (this.pending !== "") {
      this.emit(this.pending);
      this.pending = "";
    }
  }
}

/**
 * Runs a boot hook as its own process-group leader so a timeout can terminate
 * the children it started too — a script that backgrounded a build must not
 * outlive the deadline that killed it.
 */
export class NodeHookSpawner implements HookSpawner {
  spawn(request: HookSpawnRequest): Result<HookProcess, HookSpawnError> {
    return Result.fromThrowable(
      (): HookProcess => {
        // Truncates the previous run's log, as Amp does (docs/orb-setup-hook.md).
        const logFile = createWriteStream(request.logPath, { flags: "w" });
        const child = spawn(request.executable, [], {
          cwd: request.cwd,
          env: { ...request.env },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        const tail: string[] = [];
        const emit = (line: string): void => {
          tail.push(line);
          if (tail.length > STATUS_TAIL_LINES) tail.shift();
          request.onLine(line);
        };
        // A log file that cannot be written must not take the boot with it;
        // the hook's own outcome is still captured through the tail.
        logFile.on("error", (error) => request.onLine(`log capture failed: ${error.message}`));
        // One splitter per stream: sharing a buffer between stdout and stderr
        // splices a half-written line of one onto a line of the other, and the
        // tail and the log mirror are exactly what a human reads afterwards.
        const splitters = [child.stdout, child.stderr].map((stream) => {
          const splitter = new LineSplitter(emit);
          stream.setEncoding("utf8");
          stream.on("data", (chunk: string) => {
            logFile.write(chunk);
            splitter.push(chunk);
          });
          return splitter;
        });

        const pid = child.pid;
        let killed = false;
        const exited = new Promise<HookProcessExit>((resolve) => {
          const settle = (exit: HookProcessExit): void => {
            for (const splitter of splitters) splitter.flush();
            logFile.end();
            resolve(exit);
          };
          // A spawn failure is an exit too: the port never rejects, so the
          // runner reports `failed` instead of crashing the boot.
          child.on("error", (error) => {
            emit(error.message);
            settle({ code: null, signal: null });
          });
          child.on("close", (code, signal) => settle({ code, signal }));
        });

        return {
          exited,
          killGroup: (): void => {
            if (killed || pid === undefined) return;
            killed = true;
            // A negative PID targets the group `detached: true` created.
            Result.fromThrowable(
              () => process.kill(-pid, "SIGKILL"),
              () => undefined,
            )();
          },
          tail: (): readonly string[] => [...tail],
        };
      },
      (error): HookSpawnError => ({
        type: "hook_spawn_error",
        message: error instanceof Error ? error.message : String(error),
      }),
    )();
  }
}
