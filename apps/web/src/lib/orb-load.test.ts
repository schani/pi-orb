import type { OrbView } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { history } from "../testkit/transcript.ts";
import type { ApiError } from "./api.ts";
import { startOrbLoad } from "./orb-load.ts";
import { snapshotFromHistory, TranscriptCache } from "./transcript-cache.ts";

const orb = (id = "a", state: OrbView["state"] = "running") =>
  ({ id, projectId: "p", state }) as OrbView;
const missing: ApiError = {
  type: "http",
  status: 404,
  code: "not_found",
  message: "Orb doesn't exist",
  retryable: false,
};

it.each(["running", "stopped", "archived"] as const)(
  "%s cache hit requires metadata, not history",
  async (state) => {
    const cache = new TranscriptCache();
    const snapshot = snapshotFromHistory(history());
    cache.acquire("a", "p").publish(snapshot);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getHistory = vi.fn(async () => ok(history()));
    const getOrb = vi.fn(async () => {
      await gate;
      return ok(orb("a", state));
    });
    const load = startOrbLoad({ orbId: "a", cache, getOrb, getHistory });
    expect(getOrb).toHaveBeenCalledOnce();
    expect(getHistory).not.toHaveBeenCalled();
    release();
    const result = await load.result;
    expect(result?.cacheHit).toBe(true);
    if (result?.history.isOk()) expect(result.history.value.records).toBe(snapshot.records);
    expect(getHistory).not.toHaveBeenCalled();
  },
);

it("cold reads start in parallel; a cancelled A load cannot publish during A→B→A", async () => {
  const cache = new TranscriptCache();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getOrb = vi.fn(async () => {
    await gate;
    return ok(orb());
  });
  const getHistory = vi.fn(async () => ok(history()));
  const old = startOrbLoad({ orbId: "a", cache, getOrb, getHistory });
  expect(getOrb).toHaveBeenCalledOnce();
  expect(getHistory).toHaveBeenCalledOnce();
  old.cancel();
  const current = startOrbLoad({ orbId: "a", cache, getOrb: async () => ok(orb()), getHistory });
  expect((await current.result)?.history.isOk()).toBe(true);
  release();
  expect(await old.result).toBeNull();
  // Loads don't publish speculative history; only the applied reducer state does.
  expect(cache.get("a")).toBeUndefined();
});

it("missing metadata invalidates cached history and its outstanding writer", async () => {
  const cache = new TranscriptCache();
  const owner = cache.acquire("a", "p");
  const snapshot = snapshotFromHistory(history());
  owner.publish(snapshot);
  const load = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => err(missing),
    getHistory: async () => ok(history()),
  });
  expect((await load.result)?.orb.isErr()).toBe(true);
  expect(cache.get("a")).toBeUndefined();
  expect(owner.publish(snapshot)).toBe("stale");
});

it("never restores a cache invalidated while metadata was pending", async () => {
  const cache = new TranscriptCache();
  cache.acquire("a", "p").publish(snapshotFromHistory(history()));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => {
      await gate;
      return ok(orb());
    },
    getHistory: async () => err(missing),
  });
  cache.invalidate("a");
  release();
  const result = await load.result;
  expect(result?.cacheHit).toBe(false);
  expect(result?.history.isErr()).toBe(true);
  expect(result?.orb.isErr()).toBe(true);
});

it("fences invalidation and cancellation even between promise resolution and consumer publication", async () => {
  const cache = new TranscriptCache();
  const load = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => ok(orb()),
    getHistory: async () => ok(history()),
  });
  const result = await load.result;
  expect(result?.history.isOk()).toBe(true);
  cache.invalidateProject("p");
  expect(load.accept(result)?.history.isErr()).toBe(true);
  load.cancel();
  expect(load.accept(result)).toBeNull();
});

it("mismatched response identities and retryable errors are not cache successes", async () => {
  const cache = new TranscriptCache();
  const wrong = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => ok(orb()),
    getHistory: async () => ok(history("b")),
  });
  expect((await wrong.result)?.history.isErr()).toBe(true);
  const failed = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => ok(orb()),
    getHistory: async () => err({ type: "network", message: "offline" } as ApiError),
  });
  expect((await failed.result)?.history.isErr()).toBe(true);
  expect(cache.stats.entries).toBe(0);
});
