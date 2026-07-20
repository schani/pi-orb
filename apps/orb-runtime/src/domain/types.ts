import type { HarnessSessionMetadata, HistoryRecord } from "@pi-orb/protocol";

/**
 * A synchronous, immutable snapshot of the harness's persisted session
 * (DESIGN.md §8.1): complete records in append order plus identity/activity.
 * Captured at the start of each request; records appended afterward belong to
 * the next request.
 */
export interface HarnessSnapshot {
  readonly orbId: string;
  readonly runtimeInstanceId: string;
  readonly activity: "idle" | "busy";
  readonly session: HarnessSessionMetadata;
  readonly records: readonly HistoryRecord[];
  readonly headId: string | null;
}

/** The accumulated state of one in-flight operation, for reconnect replay. */
export interface LiveBlockState {
  readonly blockId: string;
  readonly blockType: "text" | "reasoning";
  readonly revision: number;
  readonly text: string;
}

export interface LiveToolState {
  readonly callId: string;
  readonly name: string;
  readonly revision: number;
  readonly state: "running" | "completed" | "failed";
  readonly message?: string;
}

export interface LiveOperationView {
  readonly operationId: string;
  readonly blocks: readonly LiveBlockState[];
  readonly tools: readonly LiveToolState[];
}
