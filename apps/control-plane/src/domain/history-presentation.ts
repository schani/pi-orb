import type { HistoryRecord } from "@pi-orb/protocol";
import { err, ok, type Result } from "neverthrow";
import type { StoreError } from "./errors.ts";

const corruption = (message: string): Result<never, StoreError> =>
  err({ type: "store_error", code: "corruption", message, retryable: false });

function compareRecords(a: HistoryRecord, b: HistoryRecord): number {
  return (
    (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Root chronology between components; timestamp-prioritized causal order within each. */
export function orderHistoryForPresentation(
  records: readonly HistoryRecord[],
  cursor: string,
): Result<HistoryRecord[], StoreError> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const last = byId.get(cursor);
  if (last === undefined) return corruption("history presentation cursor is missing");
  const children = new Map<string, HistoryRecord[]>();
  const roots: HistoryRecord[] = [];
  for (const record of records) {
    if (record.parentId === null) {
      roots.push(record);
    } else {
      if (!byId.has(record.parentId)) return corruption("history presentation parent is missing");
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record);
      children.set(record.parentId, siblings);
    }
  }
  if (children.has(cursor)) return corruption("history presentation cursor has descendants");
  const ordered: HistoryRecord[] = [];
  for (const root of roots.sort(compareRecords)) {
    const ready = [root];
    while (ready.length > 0) {
      const record = ready.shift();
      if (record === undefined || record.id === cursor) continue;
      ordered.push(record);
      ready.push(...(children.get(record.id) ?? []));
      ready.sort(compareRecords);
    }
  }
  // Unreachable records indicate a cycle or missing parent. Never return partial history.
  if (ordered.length !== records.length - 1) {
    return corruption("history presentation has a cycle or missing parent");
  }
  return ok([...ordered, last]);
}
