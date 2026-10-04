import type { OrbView } from "@pi-orb/protocol";
import { err, ok } from "neverthrow";
import { expect, it, vi } from "vitest";
import { history } from "../testkit/transcript.ts";
import type { ApiError } from "./api.ts";
import { retainsOrbSelection, startOrbLoad } from "./orb-load.ts";
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
  "%s cache hit selects provisional history before metadata, without another history read",
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
    expect(load.initial?.orb).toBeNull();
    expect(load.initial?.history.isOk()).toBe(true);
    if (load.initial?.history.isOk())
      expect(load.initial.history.value.records).toBe(snapshot.records);
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

it("cached A→B→A selections fence the old A completion and never acquire publication authority", async () => {
  const cache = new TranscriptCache();
  const a = snapshotFromHistory(history());
  const b = snapshotFromHistory(history("b"));
  const aOwner = cache.acquire("a", "p");
  aOwner.publish(a);
  aOwner.release();
  const bOwner = cache.acquire("b", "p");
  bOwner.publish(b);
  bOwner.release();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getHistory = vi.fn(async (id: string) => ok(history(id)));
  const oldA = startOrbLoad({
    orbId: "a",
    cache,
    getHistory,
    getOrb: async () => {
      await gate;
      return ok(orb());
    },
  });
  expect(oldA.initial?.orb).toBeNull();
  oldA.cancel();
  const selectedB = startOrbLoad({
    orbId: "b",
    cache,
    getHistory,
    getOrb: async () => {
      await gate;
      return ok(orb("b"));
    },
  });
  expect(selectedB.initial?.history.isOk() && selectedB.initial.history.value.records).toBe(
    b.records,
  );
  selectedB.cancel();
  const currentA = startOrbLoad({ orbId: "a", cache, getHistory, getOrb: async () => ok(orb()) });
  expect(currentA.initial?.history.isOk() && currentA.initial.history.value.records).toBe(
    a.records,
  );
  await currentA.result;
  release();
  expect(await oldA.result).toBeNull();
  expect(await selectedB.result).toBeNull();
  expect(cache.stats.owners).toBe(0);
  expect(getHistory).not.toHaveBeenCalled();
});

it("return to still-visible A cancels cold B without replacing A or reading metadata again", async () => {
  const cache = new TranscriptCache();
  const getOrb = vi.fn(async (id: string) => ok(orb(id)));
  const getHistory = vi.fn(async (id: string) => ok(history(id)));
  const a = await startOrbLoad({ orbId: "a", cache, getOrb, getHistory }).result;
  expect(a).not.toBeNull();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const b = startOrbLoad({
    orbId: "b",
    cache,
    getOrb: async () => {
      await gate;
      return ok(orb("b"));
    },
    getHistory,
  });
  expect(b.initial).toBeNull();
  b.cancel();
  expect(retainsOrbSelection(a, "a")).toBe(true);
  release();
  expect(await b.result).toBeNull();
  expect(getOrb).toHaveBeenCalledOnce();
  expect(a?.orb.isOk()).toBe(true);
});

it("same-visible provisional selection still needs metadata completion", () => {
  expect(
    retainsOrbSelection(
      { orbId: "a", orb: null, history: ok(snapshotFromHistory(history())), cacheHit: true },
      "a",
    ),
  ).toBe(false);
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

it("metadata failure retains the selected snapshot without granting metadata authority", async () => {
  const cache = new TranscriptCache();
  const snapshot = snapshotFromHistory(history());
  cache.acquire("a", "p").publish(snapshot);
  const diagnostic = vi.fn();
  const load = startOrbLoad({
    orbId: "a",
    cache,
    diagnostic,
    getOrb: async () => err({ type: "network", message: "offline" } as ApiError),
    getHistory: vi.fn(async () => ok(history())),
  });
  expect(diagnostic.mock.calls[0]?.[0]).toEqual({
    phase: "cached_selection",
    orbId: "a",
    cacheHit: true,
    records: snapshot.records.size,
  });
  expect(load.initial?.orb).toBeNull();
  const result = await load.result;
  expect(result?.orb?.isErr()).toBe(true);
  expect(result?.history.isOk() && result.history.value.records).toBe(snapshot.records);
  expect(diagnostic.mock.calls[1]?.[0].phase).toBe("metadata_completion");
});

it("a stale successful metadata response cannot resurrect a newer missing observation", async () => {
  const cache = new TranscriptCache();
  cache.acquire("a", "p").publish(snapshotFromHistory(history()));
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => {
      await gate;
      return ok(orb());
    },
    getHistory: async () => ok(history()),
  });
  const missingLoad = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => err(missing),
    getHistory: async () => ok(history()),
  });
  await missingLoad.result;
  release();
  expect((await stale.result)?.orb?.isErr()).toBe(true);
  expect(cache.get("a")).toBeUndefined();
});

it.each(["deleting"] as const)("%s metadata invalidates provisional history", async (state) => {
  const cache = new TranscriptCache();
  cache.acquire("a", "p").publish(snapshotFromHistory(history()));
  const load = startOrbLoad({
    orbId: "a",
    cache,
    getOrb: async () => ok(orb("a", state)),
    getHistory: async () => ok(history()),
  });
  expect(load.initial?.history.isOk()).toBe(true);
  expect((await load.result)?.history.isErr()).toBe(true);
  expect(cache.get("a")).toBeUndefined();
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
