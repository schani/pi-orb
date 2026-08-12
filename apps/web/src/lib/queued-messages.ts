import type { HistoryRecord, OrbMessageView } from "@pi-orb/protocol";

/**
 * Guards the queued-message list against the poll/enqueue race.
 *
 * The orb page refreshes `queuedMessages` from a periodic `listOrbMessages`
 * poll that wholesale-replaces the array, while a successful enqueue appends
 * the new message optimistically. A poll request that started *before* the
 * enqueue committed can resolve *after* the optimistic append and would
 * replace the array with a snapshot that predates the just-sent message —
 * making it visibly vanish until the next poll (with a stopped orb there is no
 * runtime history record covering the gap, so users re-send).
 *
 * The epoch is bumped when a message mutation commits. Every read snapshots it
 * when the request starts and is discarded if it changed by the time the
 * response resolved; the next poll reconciles.
 */
export interface MutationEpoch {
  /** Snapshot to take when a read request starts. */
  begin: () => number;
  /** True when a message mutation committed while the read was in flight. */
  isStale: (token: number) => boolean;
  /** Records a committed message mutation, invalidating in-flight reads. */
  commit: () => void;
}

export function createMutationEpoch(): MutationEpoch {
  let epoch = 0;
  return {
    begin: () => epoch,
    isStale: (token) => token !== epoch,
    commit: () => {
      epoch += 1;
    },
  };
}

export function inboxMessageIds(record: HistoryRecord): string[] {
  const native = record.overflow["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return [];
  if (native["customType"] !== "pi-orb.user-message") return [];
  const details = native["details"];
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  if (Array.isArray(details["messageIds"])) {
    return details["messageIds"].filter((id): id is string => typeof id === "string");
  }
  return typeof details["messageId"] === "string" ? [details["messageId"]] : [];
}

export function representedInboxMessageIds(records: readonly HistoryRecord[]): Set<string> {
  return new Set(records.flatMap(inboxMessageIds));
}

/**
 * Inbox rows that still need a provisional transcript turn.
 *
 * `delivered` is a control-plane replication fact, not proof that this browser
 * has applied the corresponding record. Retire it only at the identity-based
 * history handoff. Failed rows are terminal UI resources and remain visible.
 */
export function messagesAwaitingHistory(
  items: readonly OrbMessageView[],
  records: readonly HistoryRecord[],
): OrbMessageView[] {
  const represented = representedInboxMessageIds(records);
  return items.filter((message) => message.status !== "delivered" || !represented.has(message.id));
}

export function hasDeliveredMessageAwaitingHistory(
  items: readonly OrbMessageView[],
  records: readonly HistoryRecord[],
): boolean {
  const represented = representedInboxMessageIds(records);
  return items.some((message) => message.status === "delivered" && !represented.has(message.id));
}

/** Optimistic append; any existing entry for the same message id is replaced. */
export function withQueuedMessage(
  current: readonly OrbMessageView[],
  message: OrbMessageView,
): OrbMessageView[] {
  return [...current.filter((existing) => existing.id !== message.id), message];
}
