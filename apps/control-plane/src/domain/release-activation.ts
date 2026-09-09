import type { SimulationTask } from "determined";
import type { Result } from "neverthrow";
import { sleepResult } from "./dst.ts";
import { logEvent } from "./log.ts";

export type ReleaseActivationStatus =
  | "awaiting-activation"
  | "activation-unavailable"
  | "superseded";
export type ReleaseActivationError = { readonly type: "release_activation_unavailable" };
export interface ReleaseActivationReader {
  read(
    task: SimulationTask,
    stop: AbortSignal,
  ): Promise<Result<number | null, ReleaseActivationError>>;
}

/**
 * Startup barrier, not a lease. The release publishes authority only AFTER
 * proving every older browser process has retired. HTTP remains available
 * while all five autonomous loops wait. No mutation can have started here.
 */
export async function waitForReleaseActivation(
  task: SimulationTask,
  reader: ReleaseActivationReader,
  generation: number,
  stop: AbortSignal,
  report: (status: ReleaseActivationStatus | null) => void,
): Promise<boolean> {
  let previous: ReleaseActivationStatus | null = null;
  let superseded = false;
  while (!stop.aborted) {
    const result = await reader.read(task, stop);
    if (stop.aborted) return false;
    if (result.isOk() && result.value !== null && result.value > generation) superseded = true;
    if (!superseded && result.isOk() && result.value === generation) {
      report(null);
      if (previous !== null) logEvent(task, "release-activation-granted", { generation });
      return true;
    }
    const status = superseded
      ? "superseded"
      : result.isErr()
        ? "activation-unavailable"
        : "awaiting-activation";
    report(status);
    if (status !== previous) {
      logEvent(task, "release-activation-wait", { generation, status });
      previous = status;
    }
    if ((await sleepResult(task, 5_000, "release activation", stop)).isErr()) return false;
  }
  return false;
}
