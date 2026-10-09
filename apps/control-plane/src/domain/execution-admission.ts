import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "./errors.ts";
import { logOrbEvent } from "./log.ts";
import type { ControlPlaneDeps, OperationContext } from "./ports.ts";

export interface ExecutionBinding {
  readonly baseUrl: string;
  readonly token: string;
  readonly incarnation: string;
  readonly cwd: string;
}
export interface ExecutionLeaseBinding extends ExecutionBinding {
  readonly release: () => void;
}
function unavailable(message: string, cancelled = false): RuntimeClientError {
  return {
    type: "runtime_client_error",
    code: cancelled ? "cancelled" : "history_unavailable",
    answered: true,
    retryable: false,
    message,
  };
}

/** Lifecycle observation only: demand/recovery owns startup, never a waiting tool. */
export function awaitExecutionBinding(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  context: OperationContext,
  expectedAdmissionVersion?: number,
  waiting?: () => ResultAsync<void, RuntimeClientError>,
): ResultAsync<ExecutionLeaseBinding, RuntimeClientError> {
  let lease: (() => void) | undefined;
  return ResultAsync.fromPromise(
    (async () => {
      let announced = false;
      for (;;) {
        if (context.signal.aborted) return err(unavailable("execution wait cancelled", true));
        await task.checkpoint("execution.wait-observe");
        const read = await deps.store.getOrb(task, orbId);
        if (context.signal.aborted) return err(unavailable("execution wait cancelled", true));
        if (read.isErr()) return err(unavailable("execution lifecycle unavailable"));
        const orb = read.value;
        if (!orb) return err(unavailable("execution orb does not exist"));
        const archivalContinuation =
          orb.state === "archiving" &&
          expectedAdmissionVersion !== undefined &&
          deps.agentPlane?.session(orbId)?.workActive?.() === true;
        expectedAdmissionVersion ??= orb.agentAdmissionVersion;
        if (orb.agentAdmissionVersion !== expectedAdmissionVersion)
          return err(unavailable("execution admission revoked", true));
        if (orb.state === "failed")
          return err(unavailable("Execution failed; use Start or new input to retry."));
        if (
          orb.state === "archived" ||
          (orb.state === "archiving" && !archivalContinuation) ||
          orb.state === "deleting"
        )
          return err(unavailable("execution admissions closed"));
        if (orb.stopReason === "manual" || orb.stopReason === "sleep")
          return err(unavailable("Execution stopped by request."));
        if (archivalContinuation) {
          if (orb.hostRef === null)
            return err(unavailable("Execution unavailable during archival."));
          const observed = await deps.hostProvider.observe(
            task,
            { provider: deps.hostProvider.kind, resourceId: orb.hostRef },
            context,
          );
          if (context.signal.aborted) return err(unavailable("execution wait cancelled", true));
          if (
            observed.isErr() ||
            observed.value?.state !== "running" ||
            observed.value.incarnation !== orb.hostIncarnation
          )
            return err(unavailable("Execution unavailable during archival."));
        }
        if ((orb.state === "running" || archivalContinuation) && orb.hostRef !== null) {
          const acquire = deps.hostProvider.executionBinding;
          if (!acquire) return err(unavailable("execution binding unavailable"));
          const binding = await acquire.call(
            deps.hostProvider,
            task,
            { provider: deps.hostProvider.kind, resourceId: orb.hostRef },
            context,
          );
          if (context.signal.aborted) return err(unavailable("execution wait cancelled", true));
          if (binding.isErr()) return err(unavailable("execution binding unavailable"));
          lease = deps.control.acquireExecutionLease(orbId, orb.stateVersion) ?? undefined;
          if (!lease) return err(unavailable("execution admission changed"));
          await task.checkpoint("execution.binding-before-admission");
          const current = await deps.store.getOrb(task, orbId);
          if (context.signal.aborted) return err(unavailable("execution wait cancelled", true));
          if (
            current.isErr() ||
            !current.value ||
            (current.value.state !== "running" &&
              !(
                current.value.state === "archiving" &&
                deps.agentPlane?.session(orbId)?.workActive?.() === true
              )) ||
            current.value.hostIncarnation !== orb.hostIncarnation ||
            current.value.hostRef !== orb.hostRef ||
            current.value.agentAdmissionVersion !== expectedAdmissionVersion ||
            current.value.stopReason === "manual" ||
            current.value.stopReason === "sleep" ||
            deps.control.isStopping(orbId, current.value.stateVersion) ||
            binding.value.incarnation !== String(orb.hostIncarnation)
          )
            return err(unavailable("execution admission changed"));
          if (announced && waiting)
            logOrbEvent(task, orbId, "execution.wait_ready", { incarnation: orb.hostIncarnation });
          return ok({ ...binding.value, release: lease });
        }
        if (!announced) {
          announced = true;
          if (waiting) {
            const published = await waiting();
            if (published.isErr()) return err(published.error);
            logOrbEvent(task, orbId, "execution.waiting", {
              admission_version: expectedAdmissionVersion,
              compute_state: orb.state,
            });
          }
        }
        await task.sleep(100, "execution readiness wait", { signal: context.signal });
      }
    })(),
    () =>
      unavailable(
        context.signal.aborted ? "execution wait cancelled" : "execution readiness unavailable",
        context.signal.aborted,
      ),
  )
    .andThen((result) => result)
    .orTee(() => lease?.());
}
