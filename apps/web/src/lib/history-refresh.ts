import type { HistoryRecord, OrbHistoryView } from "@pi-orb/protocol";

export interface LocalHistory {
  readonly records: readonly HistoryRecord[];
  readonly afterRecordId: string | null;
  readonly headId: string | null;
}

/**
 * Merge a freshly read replicated prefix with records already received live.
 *
 * PostgreSQL history is always a prefix of the runtime's linear history. A
 * refresh may lag records already applied from the WebSocket, so replacing the
 * local transcript wholesale would lose that live suffix. Database records go
 * first in their authoritative order; local records absent from that prefix
 * stay after them in their existing live order.
 */
export function mergeReplicatedHistory(current: LocalHistory, view: OrbHistoryView): LocalHistory {
  const replicatedIds = new Set(view.records.map((record) => record.id));
  const liveSuffix = current.records.filter((record) => !replicatedIds.has(record.id));
  return {
    records: [...view.records, ...liveSuffix],
    afterRecordId: liveSuffix.length > 0 ? current.afterRecordId : view.cursor,
    headId: liveSuffix.length > 0 ? current.headId : view.headId,
  };
}
