import { describe, expect, it, vi } from "vitest";
import { history } from "../testkit/transcript.ts";
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

  it("retains more than three conversations under the byte budget without stale owners", () => {
    const cache = new TranscriptCache();
    for (const id of ["a", "b", "c", "d", "e"]) {
      const owner = cache.acquire(id, "p");
      expect(owner.publish(snapshotFromHistory(history(id)))).toBe("stored");
      owner.release();
    }
    for (const id of ["a", "b", "c", "d", "e"]) expect(cache.get(id)).toBeDefined();
    expect(cache.stats.entries).toBe(5);
    expect(cache.stats.owners).toBe(0);
  });

  it("defaults to a 256 MiB byte budget", () => {
    const cache = new TranscriptCache();
    const view = history();
    const first = view.records[0] ?? expect.fail("fixture record missing");
    if (first.type !== "message") expect.fail("message record expected");
    first.content = [{ type: "text", text: "x".repeat(65 * 1024 * 1024) }];
    expect(cache.acquire("a", "p").publish(snapshotFromHistory(view))).toBe("stored");
    expect(cache.stats.bytes).toBeGreaterThan(128 * 1024 * 1024);
    expect(cache.stats.bytes).toBeLessThan(256 * 1024 * 1024);
    const oversized = history();
    const oversizedFirst = oversized.records[0] ?? expect.fail("fixture record missing");
    if (oversizedFirst.type !== "message") expect.fail("message record expected");
    oversizedFirst.content = [{ type: "text", text: "x".repeat(128 * 1024 * 1024) }];
    expect(cache.acquire("a", "p").publish(snapshotFromHistory(oversized))).toBe("oversized");
    expect(cache.stats.bytes).toBe(0);
  });

  it("evicts least-recently-used conversations when accounted bytes exceed the budget", () => {
    const sample = new TranscriptCache();
    sample.acquire("a", "p").publish(snapshotFromHistory(history()));
    const cache = new TranscriptCache({ maxBytes: sample.stats.bytes * 2 });
    for (const id of ["a", "b"]) {
      expect(cache.acquire(id, "p").publish(snapshotFromHistory(history()))).toBe("stored");
    }
    cache.get("a");
    expect(cache.acquire("c", "p").publish(snapshotFromHistory(history()))).toBe("stored");
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("does not claim a replacement snapshot was stored when retained images evict its older orb", () => {
    const sample = new TranscriptCache();
    sample.acquire("a", "p").publish(snapshotFromHistory(history()));
    const baseline = sample.stats.bytes;
    const cache = new TranscriptCache({ maxBytes: baseline * 4 + 200 });
    const first = cache.acquire("a", "p");
    const second = cache.acquire("b", "p");
    expect(first.publish(snapshotFromHistory(history()))).toBe("stored");
    const blob = new Blob([new Uint8Array(baseline * 2)], { type: "image/png" });
    expect(
      first.publishImage({
        sessionId: "session",
        recordId: "one",
        detailKey: "one:0",
        imageIndex: 0,
        blob,
      }),
    ).toBe("stored");
    expect(second.publish(snapshotFromHistory(history()))).toBe("stored");
    expect(cache.stats.entries).toBe(2);
    const view = history();
    const record = view.records[0] ?? expect.fail("fixture record missing");
    if (record.type !== "message") expect.fail("message record expected");
    record.content = [{ type: "text", text: "x".repeat(baseline) }];
    const expanded = snapshotFromHistory(view);
    expect(
      new TranscriptCache({ maxBytes: baseline * 4 + 200 }).acquire("c", "p").publish(expanded),
    ).toBe("stored");
    expect(first.publish(expanded)).toBe("oversized");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.stats.bytes).toBeLessThanOrEqual(baseline * 4 + 200);
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
    if (first.type !== "message") expect.fail("message record expected");
    first.content = [{ type: "text", text: "x".repeat(bytes) }];
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
