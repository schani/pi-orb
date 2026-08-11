import type { OrbMessageView } from "@pi-orb/protocol";

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

/** The queue shown beside the transcript: everything not yet delivered. */
export function undeliveredMessages(items: readonly OrbMessageView[]): OrbMessageView[] {
  return items.filter((message) => message.status !== "delivered");
}

/** Optimistic append; any existing entry for the same message id is replaced. */
export function withQueuedMessage(
  current: readonly OrbMessageView[],
  message: OrbMessageView,
): OrbMessageView[] {
  return [...current.filter((existing) => existing.id !== message.id), message];
}
