import type { SimulationTask } from "determined";
import type { Result } from "neverthrow";
import { sleepResult } from "./dst.ts";
import { logEvent } from "./log.ts";

export type ReleaseActivationStatus =
  | "awaiting-activation"
  | "activation-unavailable"
  | "superseded";
export type ReleaseActivationError = { readonly type: "release_activation_unavailable" };
export interface ReleaseAuthority {
  readonly generation: number;
  readonly retireThroughGeneration: number;
}
export interface ReleaseActivationReader {
  read(
    task: SimulationTask,
    stop: AbortSignal,
  ): Promise<Result<ReleaseAuthority | null, ReleaseActivationError>>;
}

/**
 * The release publishes activation only AFTER proving every older process has
 * retired. A retirement cutoff takes precedence over activation, including on
 * restart. HTTP remains available while the autonomous loops wait.
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
    if (result.isOk() && result.value !== null) {
      if (result.value.retireThroughGeneration >= generation) {
        logEvent(task, "release-retirement-observed", {
          generation,
          retireThroughGeneration: result.value.retireThroughGeneration,
        });
        return false;
      }
      if (result.value.generation > generation) superseded = true;
    }
    if (!superseded && result.isOk() && result.value?.generation === generation) {
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

/** Keep watching after activation; a read failure is not a retirement command. */
export async function watchReleaseRetirement(
  task: SimulationTask,
  reader: ReleaseActivationReader,
  generation: number,
  stop: AbortSignal,
): Promise<boolean> {
  let unavailable = false;
  while (!stop.aborted) {
    const result = await reader.read(task, stop);
    if (stop.aborted) return false;
    const missing = result.isErr() || result.value === null;
    if (missing !== unavailable) {
      logEvent(task, missing ? "release-retirement-unavailable" : "release-retirement-recovered", {
        generation,
      });
      unavailable = missing;
    }
    if (
      result.isOk() &&
      result.value !== null &&
      result.value.retireThroughGeneration >= generation
    ) {
      logEvent(task, "release-retirement-observed", {
        generation,
        retireThroughGeneration: result.value.retireThroughGeneration,
      });
      return true;
    }
    if ((await sleepResult(task, 5_000, "release retirement", stop)).isErr()) return false;
  }
  return false;
}
