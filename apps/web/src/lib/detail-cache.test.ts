import { expect, it } from "vitest";
import { history } from "../testkit/transcript.ts";
import { snapshotFromHistory, TranscriptCache } from "./transcript-cache.ts";

it("does not claim a detail was stored when an older orb evicts itself", () => {
  const sample = new TranscriptCache();
  sample.acquire("a", "p").publish(snapshotFromHistory(history()));
  const baseline = sample.stats.bytes;
  const cache = new TranscriptCache({ maxBytes: baseline * 2 + 100 });
  const first = cache.acquire("a", "p");
  const second = cache.acquire("b", "p");
  expect(first.publish(snapshotFromHistory(history()))).toBe("stored");
  expect(second.publish(snapshotFromHistory(history()))).toBe("stored");
  expect(
    first.publishDetail({
      v: 1,
      state: "committed",
      sessionId: "session",
      recordId: "one",
      detailKey: "one:0",
      body: { type: "reasoning", text: "x".repeat(400) },
    }),
  ).toBe("oversized");
  expect(cache.getDetail("a", "session", "one", "one:0")).toBeUndefined();
  expect(cache.get("b")).toBeDefined();
  expect(cache.stats.bytes).toBeLessThanOrEqual(baseline * 2 + 100);
});

it("shares transcript byte budget with committed detail; invalidation and ownership reject late writes", () => {
  const cache = new TranscriptCache({ maxBytes: 20000 });
  const owner = cache.acquire("a", "p");
  expect(owner.publish(snapshotFromHistory(history()))).toBe("stored");
  const first = {
    v: 1 as const,
    state: "committed" as const,
    sessionId: "session",
    recordId: "one",
    detailKey: "one:0",
    body: { type: "reasoning" as const, text: "secret" },
  };
  expect(owner.publishDetail(first)).toBe("stored");
  expect(cache.getDetail("a", "session", "one", "one:0")).toEqual(first);
  expect(
    owner.publishDetail({
      ...first,
      body: { type: "reasoning" as const, text: "x".repeat(25000) },
    }),
  ).toBe("oversized");
  expect(cache.getDetail("a", "session", "one", "one:0")).toBeUndefined();
  expect(cache.stats.bytes).toBeLessThanOrEqual(20000);
  expect(owner.publishDetail(first)).toBe("stored");
  expect(owner.publish(snapshotFromHistory(history("a", ["one"], "next-session")))).toBe("stored");
  expect(cache.getDetail("a", "session", "one", "one:0")).toBeUndefined();
  cache.invalidate("a");
  expect(cache.getDetail("a", "session", "one", "one:0")).toBeUndefined();
  expect(owner.publishDetail(first)).toBe("stale");
});
