import type { CommittedDisplayDetail, DisplayHistoryView, DisplayRecord } from "@pi-orb/protocol";

export interface CachedTranscript {
  readonly sessionId: string | null;
  readonly records: ReadonlyMap<string, DisplayRecord>;
  readonly afterRecordId: string | null;
  readonly headId: string | null;
}

export function snapshotFromHistory(view: DisplayHistoryView): CachedTranscript {
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
  publishDetail(detail: CommittedDisplayDetail): CacheAdmission;
  publishImage(image: {
    sessionId: string;
    recordId: string;
    detailKey: string;
    imageIndex: number;
    blob: Blob;
  }): CacheAdmission;
  clear(): void;
  release(): void;
}
interface Entry {
  projectId: string;
  snapshot: CachedTranscript;
  bytes: number;
  details: Map<string, { detail: CommittedDisplayDetail; bytes: number }>;
  images: Map<string, { recordId: string; blob: Blob; bytes: number }>;
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
  private readonly recordBytes = new WeakMap<DisplayRecord, number>();
  private bytes = 0;
  private invalidationSerial = 0;

  /** Fences in-flight loads across explicit resource deletion, without tombstone maps. */
  get invalidationEpoch(): number {
    return this.invalidationSerial;
  }
  private readonly maxBytes: number;

  constructor(limits: { maxBytes?: number } = {}) {
    this.maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
  }

  get stats() {
    return { entries: this.entries.size, bytes: this.bytes, owners: this.owners.size };
  }

  getDetail(
    orbId: string,
    sessionId: string,
    recordId: string,
    detailKey: string,
  ): CommittedDisplayDetail | undefined {
    const entry = this.entries.get(orbId);
    if (entry?.snapshot.sessionId !== sessionId) return undefined;
    const key = `${recordId}:${detailKey}`;
    const found = entry.details.get(key);
    if (found !== undefined) {
      entry.details.delete(key);
      entry.details.set(key, found);
      this.entries.delete(orbId);
      this.entries.set(orbId, entry);
    }
    return found?.detail;
  }

  getImage(
    orbId: string,
    sessionId: string,
    recordId: string,
    detailKey: string,
    imageIndex: number,
  ): Blob | undefined {
    const entry = this.entries.get(orbId);
    if (entry?.snapshot.sessionId !== sessionId) return undefined;
    const key = JSON.stringify([recordId, detailKey, imageIndex]);
    const found = entry.images.get(key);
    if (found !== undefined) {
      entry.images.delete(key);
      entry.images.set(key, found);
      this.entries.delete(orbId);
      this.entries.set(orbId, entry);
    }
    return found?.blob;
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
      publishImage: ({ sessionId, recordId, detailKey, imageIndex, blob }) => {
        if (!current()) return "stale";
        const entry = this.entries.get(orbId);
        if (
          entry === undefined ||
          entry.snapshot.sessionId !== sessionId ||
          !entry.snapshot.records.has(recordId) ||
          !Number.isSafeInteger(imageIndex) ||
          imageIndex < 0
        )
          return "invalid";
        const key = JSON.stringify([recordId, detailKey, imageIndex]);
        const bytes = blob.size + 128 + key.length * 2 + blob.type.length * 2;
        const previous = entry.images.get(key);
        if (previous !== undefined) {
          entry.images.delete(key);
          entry.bytes -= previous.bytes;
          this.bytes -= previous.bytes;
        }
        if (bytes > this.maxBytes || entry.bytes + bytes > this.maxBytes) return "oversized";
        entry.images.set(key, { recordId, blob, bytes });
        entry.bytes += bytes;
        this.bytes += bytes;
        while (this.bytes > this.maxBytes) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.remove(oldest);
        }
        return this.entries.has(orbId) ? "stored" : "oversized";
      },
      publishDetail: (detail) => {
        if (!current()) return "stale";
        const entry = this.entries.get(orbId);
        if (
          entry === undefined ||
          entry.snapshot.sessionId !== detail.sessionId ||
          !entry.snapshot.records.has(detail.recordId)
        )
          return "invalid";
        const key = `${detail.recordId}:${detail.detailKey}`;
        const bytes = estimateBytes(detail) + 64;
        const previous = entry.details.get(key);
        if (previous !== undefined) {
          entry.details.delete(key);
          entry.bytes -= previous.bytes;
          this.bytes -= previous.bytes;
        }
        if (bytes > this.maxBytes || entry.bytes + bytes > this.maxBytes) return "oversized";
        entry.details.set(key, { detail, bytes });
        entry.bytes += bytes;
        this.bytes += bytes;
        while (this.bytes > this.maxBytes) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.remove(oldest);
        }
        return this.entries.has(orbId) ? "stored" : "oversized";
      },
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
        const previous = this.entries.get(orbId);
        const details =
          previous?.snapshot.sessionId === snapshot.sessionId
            ? new Map(
                [...previous.details].filter(([, value]) =>
                  snapshot.records.has(value.detail.recordId),
                ),
              )
            : new Map<string, { detail: CommittedDisplayDetail; bytes: number }>();
        const images =
          previous?.snapshot.sessionId === snapshot.sessionId
            ? new Map(
                [...previous.images].filter(([, value]) => snapshot.records.has(value.recordId)),
              )
            : new Map<string, { recordId: string; blob: Blob; bytes: number }>();
        this.remove(orbId);
        if (bytes > this.maxBytes) return "oversized";
        bytes += [...details.values()].reduce((sum, value) => sum + value.bytes, 0);
        bytes += [...images.values()].reduce((sum, value) => sum + value.bytes, 0);
        this.entries.set(orbId, {
          projectId,
          details,
          images,
          snapshot: {
            sessionId: snapshot.sessionId,
            records: snapshot.records,
            afterRecordId: snapshot.afterRecordId,
            headId: snapshot.headId,
          },
          bytes,
        });
        this.bytes += bytes;
        while (this.bytes > this.maxBytes) {
          const first = this.entries.keys().next().value;
          if (first === undefined) break;
          this.remove(first);
        }
        return this.entries.has(orbId) ? "stored" : "oversized";
      },
    };
  }
}
