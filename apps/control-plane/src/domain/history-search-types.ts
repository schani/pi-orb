import type { HistoryRecord } from "@pi-orb/protocol";

export interface HistorySearchParams {
  readonly ownerUserId: string;
  readonly projectId?: string;
  readonly orbId?: string;
  readonly terms: readonly string[];
  readonly limit: number;
}

export interface HistorySearchHit {
  readonly orbId: string;
  readonly sessionId: string;
  readonly recordId: string;
  readonly name: string | null;
  readonly projectName: string;
  readonly record: HistoryRecord;
  readonly score: number;
}

export interface HistorySearchResult {
  readonly hits: HistorySearchHit[];
  readonly documentCount: number;
  readonly candidateCount: number;
}
