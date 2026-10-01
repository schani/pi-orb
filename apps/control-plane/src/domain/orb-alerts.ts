import type { SimulationTask } from "determined";
import { err, ok, ResultAsync } from "neverthrow";
import type { ControlPlaneDeps } from "./ports.ts";
import { pollOrbUntilCaughtUp } from "./replication.ts";

export type AckAlertError = { type: "orb_not_found" | "alert_not_replicated" | "unavailable" };

/** One bounded pull gives a just-observed live alert a chance to become verifiable. */
export function ackOrbAlert(
  task: SimulationTask,
  deps: ControlPlaneDeps,
  orbId: string,
  recordId: string,
): ResultAsync<{ unreadAlertId: string | null }, AckAlertError> {
  return new ResultAsync(
    (async () => {
      const orb = await deps.store.getOrb(task, orbId);
      if (orb.isErr()) return err({ type: "unavailable" as const });
      if (orb.value === null) return err({ type: "orb_not_found" as const });
      let acknowledged = await deps.store.ackOrbAlert(task, orbId, recordId);
      if (
        acknowledged.isErr() &&
        acknowledged.error.type === "alert_not_replicated" &&
        orb.value.state === "running"
      ) {
        const pulled = await pollOrbUntilCaughtUp(task, deps, orbId, 2);
        if (pulled.type === "retryable" || pulled.type === "integrity")
          return err({ type: "unavailable" as const });
        acknowledged = await deps.store.ackOrbAlert(task, orbId, recordId);
      }
      if (acknowledged.isErr())
        return err({
          type: acknowledged.error.type === "store_error" ? "unavailable" : acknowledged.error.type,
        });
      return ok({ unreadAlertId: acknowledged.value });
    })(),
  );
}
