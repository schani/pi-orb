import type { SimulationTask } from "determined";
import { okAsync, type ResultAsync } from "neverthrow";
import type { RuntimeClientError } from "./errors.ts";
import type { CentralAgentCaller, ControlPlaneStore } from "./ports.ts";

/** Pending inbox identity is available before a native operation exists. */
export function cancelQueuedUserTurn(
  task: SimulationTask,
  store: Pick<ControlPlaneStore, "cancelPendingOrbMessage">,
  caller: CentralAgentCaller,
  operationId: string,
): ResultAsync<"cancelled" | "active" | "missing" | undefined, RuntimeClientError> {
  const match = /^inbox:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    operationId,
  );
  if (!match?.[1]) return okAsync(undefined);
  const messageId = match[1];
  return store
    .cancelPendingOrbMessage(task, {
      orbId: caller.orbId,
      messageId,
      caller,
      now: task.wallNow(),
    })
    .mapErr(
      (error): RuntimeClientError => ({
        type: "runtime_client_error",
        code: error.type === "state_conflict" ? "cancelled" : "history_unavailable",
        answered: true,
        retryable: error.type === "store_error" && error.retryable,
        message:
          error.type === "state_conflict"
            ? "Agent admission changed"
            : "Pending turn cancellation unavailable",
      }),
    );
}
