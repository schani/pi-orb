import type { SimulationTask } from "determined";
import { err, type Result, type ResultAsync } from "neverthrow";

export type ChildExit =
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "signal"; readonly signal: NodeJS.Signals; readonly number: number };

export type Health =
  | { readonly status: "initializing" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly code: string };

export type SupervisorError = {
  readonly type:
    | "signal_install_failed"
    | "spawn_failed"
    | "signal_forward_failed"
    | "health_failed"
    | "sleep_failed"
    | "diagnostic_failed";
  readonly message: string;
};

export interface SupervisorPorts<Child> {
  installSignalHandlers(handler: (signal: NodeJS.Signals) => void): Result<void, SupervisorError>;
  spawn(): Result<Child, SupervisorError>;
  poll(child: Child): Result<ChildExit, SupervisorError> | null;
  wait(child: Child): ResultAsync<ChildExit, SupervisorError>;
  forward(child: Child, signal: NodeJS.Signals): Result<void, SupervisorError>;
  health(task: SimulationTask): ResultAsync<Health, SupervisorError>;
  sleep(task: SimulationTask): ResultAsync<void, SupervisorError>;
  report(
    status: "ready" | "failed",
    code?: string,
    details?: object,
  ): ResultAsync<void, SupervisorError>;
  logDiagnosticFailure(error: SupervisorError): void;
}

function exitDetails(exit: ChildExit): object {
  return exit.type === "exit" ? { exitCode: exit.code } : { signal: exit.number };
}

async function reportBestEffort<Child>(
  ports: SupervisorPorts<Child>,
  status: "ready" | "failed",
  code?: string,
  details?: object,
): Promise<void> {
  const reported = await ports.report(status, code, details);
  if (reported.isErr()) ports.logDiagnosticFailure(reported.error);
}

export async function supervise<Child>(
  task: SimulationTask,
  ports: SupervisorPorts<Child>,
): Promise<Result<ChildExit, SupervisorError>> {
  let child: Child | undefined;
  const installed = ports.installSignalHandlers((signal) => {
    if (child === undefined || ports.poll(child) !== null) return;
    const forwarded = ports.forward(child, signal);
    if (forwarded.isErr()) ports.logDiagnosticFailure(forwarded.error);
  });
  if (installed.isErr()) return err(installed.error);

  const spawned = ports.spawn();
  if (spawned.isErr()) return err(spawned.error);
  child = spawned.value;

  for (;;) {
    await task.checkpoint("runtime-supervisor", "before-health");
    const beforeHealth = ports.poll(child);
    if (beforeHealth !== null) {
      if (beforeHealth.isErr()) return err(beforeHealth.error);
      await reportBestEffort(
        ports,
        "failed",
        "runtime_exited_before_ready",
        exitDetails(beforeHealth.value),
      );
      return beforeHealth;
    }

    const health = await ports.health(task);
    await task.checkpoint("runtime-supervisor", "after-health");
    const afterHealth = ports.poll(child);
    if (afterHealth !== null) {
      if (afterHealth.isErr()) return err(afterHealth.error);
      await reportBestEffort(
        ports,
        "failed",
        "runtime_exited_before_ready",
        exitDetails(afterHealth.value),
      );
      return afterHealth;
    }

    if (health.isOk() && health.value.status !== "initializing") {
      if (health.value.status === "ready") await reportBestEffort(ports, "ready");
      else await reportBestEffort(ports, "failed", health.value.code);
      const waited = await ports.wait(child);
      return waited;
    }

    const slept = await ports.sleep(task);
    if (slept.isErr()) return err(slept.error);
  }
}
