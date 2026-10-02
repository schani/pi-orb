import { expect, it } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { history } from "../testkit/transcript.ts";
import { snapshotFromHistory, TranscriptCache } from "./transcript-cache.ts";

const image = (size = 13) => new Blob([new Uint8Array(size)], { type: "image/png" });
const admission = (blob: Blob) => ({
  sessionId: "session",
  recordId: "one",
  detailKey: "one:0",
  imageIndex: 0,
  blob,
});

it("accounts for binary bytes in the shared budget and reuses duplicate image admission", () => {
  const cache = new TranscriptCache();
  const owner = cache.acquire("a", "p");
  expect(owner.publish(snapshotFromHistory(history()))).toBe("stored");
  const before = cache.stats.bytes;
  const blob = image(500);
  expect(owner.publishImage(admission(blob))).toBe("stored");
  const admitted = cache.stats.bytes;
  expect(admitted).toBeGreaterThanOrEqual(before + blob.size);
  expect(cache.getImage("a", "session", "one", "one:0", 0)).toBe(blob);
  expect(owner.publishImage(admission(blob))).toBe("stored");
  expect(cache.stats.bytes).toBe(admitted);
  expect(cache.getImage("a", "wrong", "one", "one:0", 0)).toBeUndefined();
  expect(cache.getImage("a", "session", "one", "one:0", 1)).toBeUndefined();
  expect(owner.publishImage({ ...admission(image()), detailKey: "one:1", imageIndex: 1 })).toBe(
    "stored",
  );
  expect(cache.getImage("a", "session", "one", "one:1", 1)).toBeDefined();
});

it("evicts least recently used conversations for image bytes and rejects oversized images without retaining them", () => {
  const sample = new TranscriptCache();
  sample.acquire("a", "p").publish(snapshotFromHistory(history()));
  const baseline = sample.stats.bytes;
  const cache = new TranscriptCache({ maxBytes: baseline * 2 + 1000 });
  const first = cache.acquire("a", "p");
  const second = cache.acquire("b", "p");
  expect(first.publish(snapshotFromHistory(history()))).toBe("stored");
  expect(second.publish(snapshotFromHistory(history()))).toBe("stored");
  expect(first.publishImage(admission(image(400)))).toBe("stored");
  expect(second.publishImage(admission(image(900)))).toBe("stored");
  expect(cache.get("a")).toBeUndefined();
  expect(cache.getImage("b", "session", "one", "one:0", 0)).toBeDefined();
  const retained = cache.stats.bytes;
  expect(second.publishImage(admission(image(baseline * 3)))).toBe("oversized");
  expect(cache.getImage("b", "session", "one", "one:0", 0)).toBeUndefined();
  expect(cache.stats.bytes).toBeLessThan(retained);
  expect(cache.stats.bytes).toBeLessThanOrEqual(baseline * 2 + 1000);
});

it("does not claim an image was stored when an older orb evicts itself", () => {
  const sample = new TranscriptCache();
  sample.acquire("a", "p").publish(snapshotFromHistory(history()));
  const baseline = sample.stats.bytes;
  const cache = new TranscriptCache({ maxBytes: baseline * 2 + 100 });
  const first = cache.acquire("a", "p");
  const second = cache.acquire("b", "p");
  expect(first.publish(snapshotFromHistory(history()))).toBe("stored");
  expect(second.publish(snapshotFromHistory(history()))).toBe("stored");
  expect(first.publishImage(admission(image(400)))).toBe("oversized");
  expect(cache.getImage("a", "session", "one", "one:0", 0)).toBeUndefined();
  expect(cache.get("b")).toBeDefined();
  expect(cache.stats.bytes).toBeLessThanOrEqual(baseline * 2 + 100);
});

it("prunes images on session and record replacement, clear, orb/project invalidation and owner replacement", () => {
  const cache = new TranscriptCache();
  const owner = cache.acquire("a", "p");
  const full = snapshotFromHistory(history("a", ["one", "two"]));
  expect(owner.publish(full)).toBe("stored");
  expect(owner.publishImage(admission(image()))).toBe("stored");
  expect(owner.publish({ ...full, records: new Map(full.records) })).toBe("stored");
  expect(cache.getImage("a", "session", "one", "one:0", 0)).toBeDefined();
  expect(owner.publish(snapshotFromHistory(history("a", ["two"])))).toBe("stored");
  expect(cache.getImage("a", "session", "one", "one:0", 0)).toBeUndefined();
  expect(owner.publishImage(admission(image()))).toBe("invalid");
  expect(owner.publish(full)).toBe("stored");
  expect(owner.publishImage(admission(image()))).toBe("stored");
  expect(owner.publish(snapshotFromHistory(history("a", ["one"], "next-session")))).toBe("stored");
  expect(cache.getImage("a", "session", "one", "one:0", 0)).toBeUndefined();
  expect(owner.publishImage(admission(image()))).toBe("invalid");
  expect(owner.publish(full)).toBe("stored");
  expect(owner.publishImage(admission(image()))).toBe("stored");
  owner.clear();
  expect(cache.getImage("a", "session", "one", "one:0", 0)).toBeUndefined();
  expect(owner.publish(full)).toBe("stored");
  expect(owner.publishImage(admission(image()))).toBe("stored");
  const replacement = cache.acquire("a", "p");
  expect(owner.publishImage(admission(image()))).toBe("stale");
  cache.invalidateProject("p");
  expect(cache.stats.bytes).toBe(0);
  expect(replacement.publishImage(admission(image()))).toBe("stale");
  const latest = cache.acquire("a", "p");
  expect(latest.publish(full)).toBe("stored");
  expect(latest.publishImage(admission(image()))).toBe("stored");
  cache.invalidate("a");
  expect(cache.stats.bytes).toBe(0);
  expect(latest.publishImage(admission(image()))).toBe("stale");
});

it("DST: a response from an old lease cannot repopulate images after deletion", async () => {
  await runDst({ name: "image-cache-owner-deletion", iterations: 30 }, async (sim) => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    expect(owner.publish(snapshotFromHistory(history()))).toBe("stored");
    let deletionDone!: () => void;
    const deleted = new Promise<void>((resolve) => {
      deletionDone = resolve;
    });
    const result = await sim.runTasks([
      {
        name: "old read",
        f: async (task) => {
          await task.checkpoint("image response pending");
          await deleted;
          expect(owner.publishImage(admission(image()))).toBe("stale");
        },
      },
      {
        name: "delete",
        f: async (task) => {
          await task.checkpoint("delete while image pending");
          cache.invalidate("a");
          deletionDone();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(cache.getImage("a", "session", "one", "one:0", 0)).toBeUndefined();
    expect(cache.stats.bytes).toBe(0);
  });
});
