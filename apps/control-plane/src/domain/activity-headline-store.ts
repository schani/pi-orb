import type { SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import type { StoreError } from "./errors.ts";

export interface ActivityHeadlineRef {
  readonly orbId: string;
  readonly sessionId: string;
  readonly recordId: string;
  readonly detailKey: string;
}

export interface StoredActivityHeadline extends ActivityHeadlineRef {
  readonly headline: string;
  readonly generatedAt: number;
}

export interface ActivityHeadlineStore {
  readActivityHeadline(
    task: SimulationTask,
    ref: ActivityHeadlineRef,
  ): ResultAsync<StoredActivityHeadline | null, StoreError>;
  readActivityHeadlines(
    task: SimulationTask,
    orbId: string,
    sessionId: string,
  ): ResultAsync<StoredActivityHeadline[], StoreError>;
  /** Null means fenced; success returns the stored winner, including its timestamp. */
  putActivityHeadlineIfAbsent(
    task: SimulationTask,
    value: StoredActivityHeadline,
  ): ResultAsync<StoredActivityHeadline | null, StoreError>;
}
