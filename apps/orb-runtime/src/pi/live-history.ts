import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HistoryRecord } from "@pi-orb/protocol";
import { mapPiEntry } from "./mapping.ts";

interface PiEntrySource {
  getEntries(): unknown[];
}

type PersistenceBoundary = AgentSessionEvent["type"];

/**
 * Publishes newly persisted Pi entries without relying on `entry_appended`.
 * Pi emits that event only for extension-created custom entries; ordinary
 * messages are persisted immediately after subscribers receive `message_end`.
 */
export class LiveHistoryPublisher {
  private readonly source: PiEntrySource;
  private readonly publish: (record: HistoryRecord) => void;
  private readonly knownIds = new Set<string>();
  private flushScheduled = false;

  constructor(source: PiEntrySource, publish: (record: HistoryRecord) => void) {
    this.source = source;
    this.publish = publish;
    for (const entry of source.getEntries()) {
      const id = this.entryId(entry);
      if (id !== null) this.knownIds.add(id);
    }
  }

  observe(type: PersistenceBoundary): void {
    if (type === "message_end") {
      this.scheduleFlushAfterPiPersistsMessage();
    } else if (type === "entry_appended" || type === "agent_settled") {
      // entry_appended follows persistence. agent_settled is the final
      // synchronous barrier before transient operation state is cleared.
      this.flush();
    }
  }

  private scheduleFlushAfterPiPersistsMessage(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    for (const entry of this.source.getEntries()) {
      const id = this.entryId(entry);
      if (id !== null && this.knownIds.has(id)) continue;

      const mapped = mapPiEntry(entry);
      // Preserve append-order continuity: a bad entry makes the HTTP pull fail
      // and must not be skipped in the live stream either.
      if (mapped.isErr()) return;
      this.knownIds.add(mapped.value.id);
      this.publish(mapped.value);
    }
  }

  private entryId(entry: unknown): string | null {
    if (typeof entry !== "object" || entry === null || !("id" in entry)) return null;
    return typeof entry.id === "string" ? entry.id : null;
  }
}
