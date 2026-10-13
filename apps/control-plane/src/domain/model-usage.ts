import type { ModelCallUse } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";

export type { ModelCallUse } from "@pi-orb/protocol";

/** One `model_calls` row (docs/model-usage.md): provider-reported accounting, never content. */
export interface ModelCall {
  readonly ownerUserId: string;
  readonly orbId: string;
  readonly use: ModelCallUse;
  readonly provider: string;
  readonly model: string;
  /** `AssistantMessage.stopReason`. */
  readonly outcome: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly durationMs?: number;
}

/** Content-free ledger of platform-managed model calls; `record` stamps the time and never blocks or fails the call. */
export interface ModelUsageLedger {
  record(task: SimulationTask, call: ModelCall): void;
}
