import { type ChildProcess, execFile, spawn } from "node:child_process";
import { constants } from "node:os";
import process from "node:process";
import { promisify } from "node:util";
import type { SimulationTask } from "determined";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  ResultAsync,
  type Result as ResultType,
} from "neverthrow";
import type { ChildExit, Health, SupervisorError, SupervisorPorts } from "./core.ts";

const HEALTH_URL = "http://127.0.0.1:8080/v1/health";
const DIAGNOSTIC = "/usr/local/bin/pi-orb-boot-diagnostic";
const RUNTIME = ["/usr/local/bin/node", "apps/orb-runtime/src/main.ts"] as const;
const FAILURE_CODE = /^[a-z0-9_]{1,80}$/;
const execFileAsync = promisify(execFile);

export interface RuntimeChild {
  readonly process: ChildProcess;
  readonly pid: number;
  terminal: ResultType<ChildExit, SupervisorError> | null;
  readonly waiters: Array<(result: ResultType<ChildExit, SupervisorError>) => void>;
}

export interface NodeSupervisorOptions {
  readonly command?: readonly [string, ...string[]];
  readonly healthUrl?: string;
  readonly diagnostic?: string;
}

const childExit = (code: number | null, signal: NodeJS.Signals | null): ChildExit =>
  signal === null
    ? { type: "exit", code: code ?? 1 }
    : { type: "signal", signal, number: constants.signals[signal] };

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const failure = (type: SupervisorError["type"], cause: unknown): SupervisorError => ({
  type,
  message: message(cause),
});

export function parseHealth(value: unknown): ResultType<Health, SupervisorError> {
  if (typeof value !== "object" || value === null || !("status" in value))
    return err({ type: "health_failed", message: "health response is not an object with status" });
  const status = value.status;
  if (status === "ready") return ok({ status });
  if (status === "initializing") return ok({ status });
  if (status !== "failed")
    return err({ type: "health_failed", message: "health response has an unknown status" });
  const error = "error" in value ? value.error : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return ok({ status, code: FAILURE_CODE.test(code) ? code : "runtime_failed" });
}

export class NodeSupervisorPorts implements SupervisorPorts<RuntimeChild> {
  private readonly command: readonly [string, ...string[]];
  private readonly healthUrl: string;
  private readonly diagnostic: string;

  constructor(options: NodeSupervisorOptions = {}) {
    this.command = options.command ?? RUNTIME;
    this.healthUrl = options.healthUrl ?? HEALTH_URL;
    this.diagnostic = options.diagnostic ?? DIAGNOSTIC;
  }

  installSignalHandlers(handler: (signal: NodeJS.Signals) => void) {
    return Result.fromThrowable(
      () => {
        process.on("SIGTERM", handler);
        process.on("SIGINT", handler);
      },
      (cause) => failure("signal_install_failed", cause),
    )();
  }

  spawn(): ResultType<RuntimeChild, SupervisorError> {
    const [executable, ...args] = this.command;
    const spawned = Result.fromThrowable(
      () => spawn(executable, args, { detached: true, stdio: "inherit" }),
      (cause) => failure("spawn_failed", cause),
    )();
    if (spawned.isErr()) return err(spawned.error);
    const runtime = spawned.value;
    if (runtime.pid === undefined) {
      runtime.once("error", () => undefined);
      return err({ type: "spawn_failed", message: "runtime child has no process ID" });
    }
    const child: RuntimeChild = {
      process: runtime,
      pid: runtime.pid,
      terminal: null,
      waiters: [],
    };
    const settle = (result: ResultType<ChildExit, SupervisorError>) => {
      if (child.terminal !== null) return;
      child.terminal = result;
      for (const waiter of child.waiters.splice(0)) waiter(result);
    };
    child.process.once("error", (cause) => settle(err(failure("spawn_failed", cause))));
    child.process.once("exit", (code, signal) => {
      settle(ok(childExit(code, signal)));
    });
    return ok(child);
  }

  poll(child: RuntimeChild): ResultType<ChildExit, SupervisorError> | null {
    return child.terminal;
  }

  wait(child: RuntimeChild): ResultAsync<ChildExit, SupervisorError> {
    if (child.terminal !== null)
      return child.terminal.isOk() ? okAsync(child.terminal.value) : errAsync(child.terminal.error);
    return new ResultAsync(
      new Promise<ResultType<ChildExit, SupervisorError>>((resolve) => child.waiters.push(resolve)),
    );
  }

  forward(child: RuntimeChild, signal: NodeJS.Signals): ResultType<void, SupervisorError> {
    const forwarded = Result.fromThrowable(
      () => {
        process.kill(-child.pid, signal);
      },
      (cause) => cause,
    )();
    if (forwarded.isOk()) return ok<void, SupervisorError>(undefined);
    if (
      typeof forwarded.error === "object" &&
      forwarded.error !== null &&
      "code" in forwarded.error &&
      forwarded.error.code === "ESRCH"
    )
      return ok<void, SupervisorError>(undefined);
    return err(failure("signal_forward_failed", forwarded.error));
  }

  health(task: SimulationTask): ResultAsync<Health, SupervisorError> {
    return ResultAsync.fromPromise(
      (async () => {
        await task.failpoint("runtime-supervisor.health");
        return fetch(this.healthUrl, { signal: AbortSignal.timeout(2_000) });
      })(),
      (cause) => failure("health_failed", cause),
    ).andThen((response) => {
      if (!response.ok)
        return err<Health, SupervisorError>({
          type: "health_failed",
          message: `health returned HTTP ${response.status}`,
        });
      return ResultAsync.fromPromise(response.json() as Promise<unknown>, (cause) =>
        failure("health_failed", cause),
      ).andThen(parseHealth);
    });
  }

  sleep(task: SimulationTask): ResultAsync<void, SupervisorError> {
    return ResultAsync.fromPromise(task.sleep(1_000, "runtime supervisor health retry"), (cause) =>
      failure("sleep_failed", cause),
    );
  }

  report(status: "ready" | "failed", code?: string, details?: object) {
    const args = ["runtime", status];
    if (code !== undefined) args.push(code);
    if (details !== undefined) args.push("", JSON.stringify(details));
    return ResultAsync.fromPromise(
      execFileAsync(this.diagnostic, args, { timeout: 30_000, killSignal: "SIGKILL" }).then(
        () => undefined,
      ),
      (cause) => failure("diagnostic_failed", cause),
    );
  }

  logDiagnosticFailure(error: SupervisorError): void {
    console.error(`runtime supervisor: ${error.type}: ${error.message}`);
  }
}
