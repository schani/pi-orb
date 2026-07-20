import { err, ok, type Result } from "neverthrow";
import {
  HISTORY_PULL_MAX_LIMIT,
  HISTORY_PULL_MIN_LIMIT,
  type PullHistoryResponse,
} from "@pi-orb/protocol";
import type { HarnessSnapshot } from "./types.ts";

export interface PullHistoryQuery {
  readonly after: string | null;
  readonly limit: number;
}

export interface PullHistoryError {
  readonly type: "pull_history_error";
  readonly code: "invalid_request" | "cursor_not_found" | "history_unavailable";
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Pure §8.1 pull semantics over one immutable snapshot. The HTTP handler
 * folds this Result into status codes.
 */
export function computePullHistory(
  snapshot: HarnessSnapshot,
  query: PullHistoryQuery,
): Result<PullHistoryResponse, PullHistoryError> {
  if (
    !Number.isInteger(query.limit) ||
    query.limit < HISTORY_PULL_MIN_LIMIT ||
    query.limit > HISTORY_PULL_MAX_LIMIT
  ) {
    return err({
      type: "pull_history_error",
      code: "invalid_request",
      message: `limit must be within ${HISTORY_PULL_MIN_LIMIT}..${HISTORY_PULL_MAX_LIMIT}`,
      retryable: false,
    });
  }
  let startIndex = 0;
  if (query.after !== null) {
    const index = snapshot.records.findIndex((record) => record.id === query.after);
    if (index === -1) {
      // Persistence never silently resets to a full replay (§8.1).
      return err({
        type: "pull_history_error",
        code: "cursor_not_found",
        message: `unknown cursor ${query.after}`,
        retryable: false,
      });
    }
    startIndex = index + 1;
  }
  const records = snapshot.records.slice(startIndex, startIndex + query.limit);
  const cursor = records.at(-1)?.id ?? query.after;
  const lastReturnedIndex = startIndex + records.length - 1;
  // headId is the active head represented after applying exactly this
  // returned prefix — never a newer head beyond a partial batch.
  const headIndex =
    snapshot.headId === null
      ? -1
      : snapshot.records.findIndex((record) => record.id === snapshot.headId);
  const headId =
    headIndex !== -1 && headIndex <= lastReturnedIndex
      ? snapshot.headId
      : (records.at(-1)?.id ?? query.after);
  return ok({
    v: 1,
    orbId: snapshot.orbId,
    runtimeInstanceId: snapshot.runtimeInstanceId,
    activity: snapshot.activity,
    session: snapshot.session,
    records: [...records],
    cursor,
    headId,
  });
}
