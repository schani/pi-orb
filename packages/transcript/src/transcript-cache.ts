import type { HistoryRecord, OrbHistoryView } from "@pi-orb/protocol";

export interface CachedTranscript {
  readonly sessionId: string | null;
  readonly records: ReadonlyMap<string, HistoryRecord>;
  readonly afterRecordId: string | null;
  readonly headId: string | null;
}

export function snapshotFromHistory(view: OrbHistoryView): CachedTranscript {
  return {
    sessionId: view.session?.id ?? null,
    records: new Map(view.records.map((record) => [record.id, record])),
    afterRecordId: view.cursor,
    headId: view.headId,
  };
}

export type CacheAdmission = "stored" | "oversized" | "invalid" | "stale";
export interface TranscriptOwner {
  publish(snapshot: CachedTranscript): CacheAdmission;
  clear(): void;
  release(): void;
}
interface Entry {
  projectId: string;
  snapshot: CachedTranscript;
  bytes: number;
}

export interface CacheEntryView {
  orbId: string;
  projectId: string;
  snapshot: CachedTranscript;
}

/** Approximate retained JS data, not a heap/RSS guarantee. No serialization or deep clone. */
function estimateBytes(value: unknown): number {
  if (typeof value === "string") return 24 + value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (Array.isArray(value))
    return 32 + value.reduce((sum, item) => sum + 8 + estimateBytes(item), 0);
  let bytes = 48;
  for (const [key, item] of Object.entries(value))
    bytes += 16 + key.length * 2 + estimateBytes(item);
  return bytes;
}

/** App-scoped bounded cache. Owners fence asynchronous writes without retained tombstones. */
export class TranscriptCache {
  private readonly entries = new Map<string, Entry>();
  private readonly owners = new Map<string, { projectId: string; identity: object }>();
  private readonly recordBytes = new WeakMap<HistoryRecord, number>();
  private bytes = 0;
  private invalidationSerial = 0;

  /** Fences in-flight loads across explicit resource deletion, without tombstone maps. */
  get invalidationEpoch(): number {
    return this.invalidationSerial;
  }
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(limits: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = limits.maxEntries ?? 3;
    this.maxBytes = limits.maxBytes ?? 128 * 1024 * 1024;
  }

  get stats() {
    return { entries: this.entries.size, bytes: this.bytes, owners: this.owners.size };
  }

  /** Least-recently-used first: the cache fixtures' comparison surface. */
  get contents(): CacheEntryView[] {
    return [...this.entries].map(([orbId, entry]) => ({
      orbId,
      projectId: entry.projectId,
      snapshot: entry.snapshot,
    }));
  }

  get(orbId: string): CachedTranscript | undefined {
    const entry = this.entries.get(orbId);
    if (!entry) return undefined;
    this.entries.delete(orbId);
    this.entries.set(orbId, entry);
    return entry.snapshot;
  }

  private remove(orbId: string): void {
    const entry = this.entries.get(orbId);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(orbId);
  }

  invalidate(orbId: string): void {
    this.invalidationSerial++;
    this.remove(orbId);
    this.owners.delete(orbId);
  }

  invalidateProject(projectId: string): void {
    this.invalidationSerial++;
    for (const [id, entry] of this.entries) if (entry.projectId === projectId) this.invalidate(id);
    for (const [id, owner] of this.owners) if (owner.projectId === projectId) this.invalidate(id);
  }

  acquire(orbId: string, projectId: string): TranscriptOwner {
    const identity = {};
    this.owners.set(orbId, { projectId, identity });
    const current = () => this.owners.get(orbId)?.identity === identity;
    return {
      clear: () => {
        if (current()) this.remove(orbId);
      },
      release: () => {
        if (current()) this.owners.delete(orbId);
      },
      publish: (snapshot) => {
        if (!current()) return "stale";
        let last: string | null = null;
        let bytes = 128;
        for (const [id, record] of snapshot.records) {
          if (id !== record.id) {
            this.remove(orbId);
            return "invalid";
          }
          last = id;
          let size = this.recordBytes.get(record);
          if (size === undefined) {
            size = estimateBytes(record);
            this.recordBytes.set(record, size);
          }
          bytes += size + 64 + id.length * 2;
        }
        if (
          last !== snapshot.afterRecordId ||
          (snapshot.headId !== null && !snapshot.records.has(snapshot.headId))
        ) {
          this.remove(orbId);
          return "invalid";
        }
        this.remove(orbId);
        if (bytes > this.maxBytes || this.maxEntries < 1) return "oversized";
        this.entries.set(orbId, {
          projectId,
          snapshot: {
            sessionId: snapshot.sessionId,
            records: snapshot.records,
            afterRecordId: snapshot.afterRecordId,
            headId: snapshot.headId,
          },
          bytes,
        });
        this.bytes += bytes;
        while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
          const first = this.entries.keys().next().value;
          if (first === undefined) break;
          this.remove(first);
        }
        return "stored";
      },
    };
  }
}
