import type {
  ActiveSubagent,
  AgentSettingsEvent,
  ClientAction,
  GoalView,
  HarnessSessionMetadata,
  HistoryRecord,
} from "@pi-orb/protocol";

/**
 * A synchronous, immutable snapshot of the harness's persisted session
 * (docs/history.md): complete records in append order plus identity/activity.
 * Captured at the start of each request; records appended afterward belong to
 * the next request.
 */
export interface HarnessSnapshot {
  readonly orbId: string;
  readonly runtimeInstanceId: string;
  readonly activity: "idle" | "busy";
  readonly work?: "compaction";
  readonly compactionAfterId?: string | null;
  readonly session: HarnessSessionMetadata;
  readonly records: readonly HistoryRecord[];
  readonly headId: string | null;
  readonly settings?: AgentSettingsEvent | null;
  /** Omitted until native support is verified; null is a supported session without a goal. */
  readonly goal?: GoalView | null;
}

export type RuntimeGoalAction = Extract<ClientAction, { type: "goal_set" | "goal_clear" }>;

export interface GoalAdmissionError {
  readonly code: "busy" | "unsupported" | "invalid_request";
  readonly message: string;
}

export interface GoalChangeError {
  readonly code: GoalAdmissionError["code"] | "internal";
  readonly message: string;
}

/** The accumulated state of one in-flight operation, for reconnect replay. */
export interface LiveBlockState {
  readonly blockId: string;
  readonly blockType: "text" | "reasoning";
  readonly contentIndex: number;
  readonly revision: number;
  readonly text: string;
  readonly redacted?: boolean;
}

export interface LiveToolState {
  readonly callId: string;
  readonly name: string;
  readonly code?: string;
  readonly revision: number;
  readonly state: "running" | "completed" | "failed";
  readonly message?: string;
}

export interface LiveOperationView {
  readonly operationId: string;
  readonly blocks: readonly LiveBlockState[];
  readonly tools: readonly LiveToolState[];
  readonly subagents: readonly ActiveSubagent[];
}
