import { describe, expect, it, vi } from "vitest";
import { history } from "./testkit/transcript.ts";
import { snapshotFromHistory, TranscriptCache } from "./transcript-cache.ts";

describe("transcript cache", () => {
  it("retains immutable parsed records with coherent cursor/head and no ephemeral state", () => {
    const cache = new TranscriptCache();
    const snapshot = snapshotFromHistory(history());
    const owner = cache.acquire("a", "project");
    expect(owner.publish(snapshot)).toBe("stored");
    expect(cache.get("a")).toEqual(snapshot);
    expect(cache.get("a")?.records).toBe(snapshot.records);
    expect(cache.get("a")?.records.get("one")).toBe(snapshot.records.get("one"));
    expect(Object.keys(snapshot).sort()).toEqual([
      "afterRecordId",
      "headId",
      "records",
      "sessionId",
    ]);
    owner.release();
    expect(cache.get("a")).toEqual(snapshot);
    expect(owner.publish(snapshot)).toBe("stale");
    expect(new TranscriptCache().get("a")).toBeUndefined();
  });

  it("projects only transcript fields and reuses per-record byte accounting", () => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    const snapshot = snapshotFromHistory(history());
    owner.publish({ ...snapshot, ...{ activity: "busy", composerText: "private draft" } });
    expect(Object.keys(cache.get("a") ?? {}).sort()).toEqual(Object.keys(snapshot).sort());
    const entries = vi.spyOn(Object, "entries");
    try {
      owner.publish({ ...snapshot, records: new Map(snapshot.records) });
      expect(entries).not.toHaveBeenCalled();
    } finally {
      entries.mockRestore();
    }
  });

  it("accepts empty history but refuses an impossible cursor or head", () => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    const empty = snapshotFromHistory(history("a", []));
    expect(owner.publish(empty)).toBe("stored");
    expect(owner.publish({ ...empty, afterRecordId: "absent" })).toBe("invalid");
    expect(cache.get("a")).toBeUndefined();
    const snapshot = snapshotFromHistory(history("a", ["one", "two"]));
    expect(owner.publish({ ...snapshot, afterRecordId: "one" })).toBe("invalid");
    expect(owner.publish({ ...snapshot, headId: "absent" })).toBe("invalid");
  });

  it("evicts by read recency and has no retained stale owners after release", () => {
    const cache = new TranscriptCache({ maxEntries: 2 });
    for (const id of ["a", "b"]) {
      const owner = cache.acquire(id, "p");
      owner.publish(snapshotFromHistory(history(id)));
      owner.release();
    }
    cache.get("a");
    const owner = cache.acquire("c", "p");
    owner.publish(snapshotFromHistory(history("c")));
    owner.release();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.stats.entries).toBe(2);
    expect(cache.stats.owners).toBe(0);
  });

  it("evicts the least recently used entry when the byte budget fills first", () => {
    const snapshot = snapshotFromHistory(history());
    const sample = new TranscriptCache({ maxEntries: 10 });
    sample.acquire("a", "p").publish(snapshot);
    sample.acquire("b", "p").publish(snapshot);
    const budget = sample.stats.bytes;

    const cache = new TranscriptCache({ maxEntries: 10, maxBytes: budget });
    for (const id of ["a", "b"]) {
      expect(cache.acquire(id, "p").publish(snapshot)).toBe("stored");
    }
    cache.get("a");
    expect(cache.acquire("c", "p").publish(snapshot)).toBe("stored");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual(snapshot);
    expect(cache.get("c")).toEqual(snapshot);
    expect(cache.stats.entries).toBe(2);
    expect(cache.stats.bytes).toBe(budget);
  });

  it("bounds accounted bytes including native payloads; oversized replacement removes old entry", () => {
    const sample = new TranscriptCache();
    sample.acquire("a", "p").publish(snapshotFromHistory(history()));
    const bytes = sample.stats.bytes;
    const cache = new TranscriptCache({ maxBytes: bytes });
    const owner = cache.acquire("a", "p");
    expect(owner.publish(snapshotFromHistory(history()))).toBe("stored");
    const view = history();
    const first = view.records[0] ?? expect.fail("fixture record missing");
    first.overflow = { native: "x".repeat(bytes) };
    expect(owner.publish(snapshotFromHistory(view))).toBe("oversized");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats.bytes).toBe(0);
  });

  it("replacement ownership and deletion fence late writes, including project invalidation", () => {
    const cache = new TranscriptCache();
    const snapshot = snapshotFromHistory(history());
    const old = cache.acquire("a", "p");
    const current = cache.acquire("a", "p");
    expect(old.publish(snapshot)).toBe("stale");
    old.release();
    expect(current.publish(snapshot)).toBe("stored");
    cache.invalidateProject("p");
    expect(current.publish(snapshot)).toBe("stale");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats.owners).toBe(0);
  });

  it("full-sync clear retains current writer, but deletion never does", () => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    const snapshot = snapshotFromHistory(history());
    owner.publish(snapshot);
    owner.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(owner.publish(snapshot)).toBe("stored");
    cache.invalidate("a");
    expect(owner.publish(snapshot)).toBe("stale");
  });
});
