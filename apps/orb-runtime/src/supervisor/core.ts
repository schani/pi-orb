import type { SimulationTask } from "determined";
import { err, type Result, type ResultAsync } from "neverthrow";

export type ChildExit =
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "signal"; readonly signal: NodeJS.Signals; readonly number: number };

export type Health = (
  | { readonly status: "initializing" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly code: string }
) & { readonly runtimeInstanceId?: string };

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
  sleep(
    task: SimulationTask,
    milliseconds?: number,
    child?: Child,
  ): ResultAsync<void, SupervisorError>;
  report(
    status: "ready" | "failed" | "telemetry",
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
  status: "ready" | "failed" | "telemetry",
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
  let ready = false;
  let unhealthy = false;
  let requestedStop = false;
  let lastLocalSuccessAt: number | null = null;
  let runtimeInstanceId: string | undefined;
  const correlation = () => ({
    lastLocalSuccessAt,
    requestedStop,
    ...(runtimeInstanceId === undefined ? {} : { runtimeInstanceId }),
  });
  const finished = async (outcome: Result<ChildExit, SupervisorError>) => {
    if (outcome.isOk())
      await reportBestEffort(ports, "telemetry", "runtime_child_exited", {
        ...exitDetails(outcome.value),
        ...correlation(),
      });
    return outcome;
  };
  const installed = ports.installSignalHandlers((signal) => {
    if (child === undefined || ports.poll(child) !== null) return;
    requestedStop = true;
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
      if (!ready)
        await reportBestEffort(
          ports,
          "failed",
          "runtime_exited_before_ready",
          exitDetails(beforeHealth.value),
        );
      return finished(beforeHealth);
    }

    const started = task.monotonicNow();
    const health = await ports.health(task);
    const probeElapsedMs = Math.max(0, task.monotonicNow() - started);
    await task.checkpoint("runtime-supervisor", "after-health");
    const afterHealth = ports.poll(child);
    if (afterHealth !== null) {
      if (afterHealth.isErr()) return err(afterHealth.error);
      if (!ready)
        await reportBestEffort(
          ports,
          "failed",
          "runtime_exited_before_ready",
          exitDetails(afterHealth.value),
        );
      return finished(afterHealth);
    }

    if (!ready) {
      if (health.isOk() && health.value.status !== "initializing") {
        runtimeInstanceId = health.value.runtimeInstanceId;
        if (health.value.status === "failed") {
          await reportBestEffort(ports, "failed", health.value.code);
          return finished(await ports.wait(child));
        }
        ready = true;
        lastLocalSuccessAt = task.wallNow();
        await reportBestEffort(ports, "ready");
      }
    } else if (health.isOk() && health.value.status === "ready") {
      lastLocalSuccessAt = task.wallNow();
      runtimeInstanceId = health.value.runtimeInstanceId ?? runtimeInstanceId;
      if (unhealthy)
        await reportBestEffort(ports, "telemetry", "runtime_health_recovered", {
          ...correlation(),
          probeElapsedMs,
          probeDeadlineMs: 2_000,
        });
      unhealthy = false;
    } else if (!unhealthy) {
      unhealthy = true;
      await reportBestEffort(ports, "telemetry", "runtime_health_failed", {
        ...correlation(),
        probeElapsedMs,
        probeDeadlineMs: 2_000,
        healthFailure: health.isErr() ? "transport" : health.value.status,
      });
    }

    const slept = await ports.sleep(task, ready ? 10_000 : 1_000, child);
    if (slept.isErr()) return err(slept.error);
  }
}
