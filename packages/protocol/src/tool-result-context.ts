interface PendingDelta<T> {
  parent: PendingDelta<T> | null;
  changes: Map<string, T | undefined>;
}

interface CausalRecord {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  content?: readonly { type: string; callId?: string }[];
}

/** Branch-local latest unconsumed call; callers choose metadata or immutable block references. */
export class ToolResultContext<T> {
  private readonly contexts = new Map<string, PendingDelta<T> | null>();

  visit<R extends CausalRecord>(
    record: R,
    selectCall: (record: R, index: number) => T,
  ): Map<number, T> {
    const matches = new Map<number, T>();
    const parent = record.parentId === null ? null : (this.contexts.get(record.parentId) ?? null);
    if (record.type === "compaction" || (record.type === "message" && record.role === "user")) {
      this.contexts.set(record.id, null);
      return matches;
    }
    const changes = new Map<string, T | undefined>();
    if (record.type === "message") {
      record.content?.forEach((block, index) => {
        if (block.callId === undefined) return;
        if (block.type === "tool_call") changes.set(block.callId, selectCall(record, index));
        if (block.type === "tool_result") {
          let context: PendingDelta<T> | null = { parent, changes };
          while (context !== null && !context.changes.has(block.callId)) context = context.parent;
          const call = context?.changes.get(block.callId);
          if (call !== undefined) matches.set(index, call);
          // Consumption shadows older calls on this branch, including within this record.
          changes.set(block.callId, undefined);
        }
      });
    }
    this.contexts.set(record.id, changes.size === 0 ? parent : { parent, changes });
    return matches;
  }
}
