import { parseUsageQuery, type UsageRequestError, type UsageView } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";

export type UsageRead = Pick<UsageView, "buckets" | "orbs">;
export interface ModelUsageReader {
  read(
    task: SimulationTask,
    ownerUserId: string,
    boundaries: readonly number[],
  ): ResultAsync<UsageRead, StoreError>;
}

export function readModelUsage(
  task: SimulationTask,
  reader: ModelUsageReader,
  ownerUserId: string,
  query: unknown,
): ResultAsync<UsageView, StoreError | UsageRequestError> {
  const edges = parseUsageQuery(query);
  if (edges.isErr()) return errAsync(edges.error);
  return reader.read(task, ownerUserId, edges.value).andThen((data) => {
    const summary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    for (const row of data.buckets) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "calls"] as const)
        summary[key] += row[key];
    }
    if (
      !Object.values(summary).every(Number.isSafeInteger) ||
      summary.input + summary.output + summary.cacheRead + summary.cacheWrite >
        Number.MAX_SAFE_INTEGER
    )
      return errAsync<UsageView, StoreError>({
        type: "store_error",
        code: "invariant",
        message: "Usage totals exceed supported precision",
        retryable: false,
      });
    return okAsync({ boundaries: edges.value, summary, ...data });
  });
}
