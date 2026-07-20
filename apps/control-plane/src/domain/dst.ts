import { isCancellation, type SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { OperationContext } from "./ports.ts";

export interface Cancelled {
  readonly type: "cancelled";
}

/**
 * Deterministic sleep as a Result. Cancellation (via the optional signal)
 * becomes a typed `cancelled` value instead of a rejection, so no exception
 * crosses into domain code.
 */
export function sleepResult(
  task: SimulationTask,
  durationMs: number,
  reason: string,
  signal?: AbortSignal,
): ResultAsync<void, Cancelled> {
  const options = signal === undefined ? undefined : { signal };
  return ResultAsync.fromPromise(task.sleep(durationMs, reason, options), (error) => {
    if (isCancellation(error) || signal?.aborted === true) {
      return { type: "cancelled" } as const;
    }
    // A non-cancellation rejection from sleep is a programming error
    // (negative duration); surface it loudly through the simulation.
    return task.abortSimulation(error);
  });
}

/**
 * Runs `f` under a deadline whose signal aborts when time runs out
 * (DESIGN.md §14): the adapter receives the signal, and the timer is always
 * cancelled when the operation settles. `f` must return a `ResultAsync` whose
 * error channel already models cancellation (adapters map aborts to typed
 * errors), so this helper never introduces a rejection.
 */
export function withDeadline<T, E>(
  task: SimulationTask,
  durationMs: number,
  reason: string,
  f: (context: OperationContext) => ResultAsync<T, E>,
): ResultAsync<T, E> {
  const deadline = task.createDeadline(durationMs, reason);
  return ResultAsync.fromSafePromise<Result<T, E>, never>(
    f({ signal: deadline.signal }).match(
      (value) => {
        deadline.cancel();
        return ok<T, E>(value);
      },
      (error) => {
        deadline.cancel();
        return err<T, E>(error);
      },
    ),
  ).andThen((result) => result);
}
