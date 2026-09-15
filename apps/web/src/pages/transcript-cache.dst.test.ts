import type { OrbView } from "@pi-orb/protocol";
import { ok } from "neverthrow";
import { expect, it } from "vitest";
import { runDst } from "../../../orb-runtime/src/testkit/sim.ts";
import { startOrbLoad } from "../lib/orb-load.ts";
import { snapshotFromHistory, TranscriptCache } from "../lib/transcript-cache.ts";
import { history } from "../testkit/transcript.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it("DST: cancelled navigation and invalidation fence actual loader/cache/reducer publication", async () => {
  await runDst({ name: "transcript-cache-navigation", iterations: 40 }, async (sim) => {
    const cache = new TranscriptCache();
    const old = cache.acquire("a", "p");
    old.publish(snapshotFromHistory(history()));
    let load: ReturnType<typeof startOrbLoad> | undefined;
    let cancelled = false;
    const result = await sim.runTasks([
      {
        name: "navigate",
        f: async (task) => {
          load = startOrbLoad({
            orbId: "a",
            cache,
            getOrb: async () => {
              await task.checkpoint("metadata completion");
              return ok({ id: "a", projectId: "p", state: "running" } as OrbView);
            },
            getHistory: async () => ok(history()),
          });
          if (cancelled) load.cancel();
          const loaded = await load.result;
          if (cancelled) expect(loaded).toBeNull();
          if (loaded?.history.isOk()) {
            const state = reducer(initialState("a"), {
              type: "history_restored",
              snapshot: loaded.history.value,
            });
            expect(state.records.get("one")?.id).toBe("one");
            expect(state.afterRecordId).toBe("one");
            expect(state.activity).toBeNull();
            expect(state.synced).toBe(false);
          }
        },
      },
      {
        name: "leave-delete",
        f: async (task) => {
          await task.checkpoint("navigation superseded");
          cancelled = true;
          load?.cancel();
          cache.invalidate("a");
          await task.checkpoint("late old writer");
          expect(old.publish(snapshotFromHistory(history("a", ["one", "late"])))).toBe("stale");
          expect(cache.get("a")).toBeUndefined();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect(cache.get("a")).toBeUndefined();
  });
});

it("DST: replica refresh cannot cross full-sync/session boundaries or discard a live suffix", async () => {
  await runDst({ name: "transcript-cache-full-sync", iterations: 40 }, async (sim) => {
    const cache = new TranscriptCache();
    const owner = cache.acquire("a", "p");
    let state = reducer(initialState("a"), { type: "history_loaded", view: history() });
    const refreshEpoch = state.historyEpoch;
    const publish = () => {
      if (state.cacheReady) owner.publish(state);
      else owner.clear();
    };
    publish();
    const result = await sim.runTasks([
      {
        name: "full-sync",
        f: async (task) => {
          await task.checkpoint("unknown cursor");
          state = reducer(state, {
            type: "frame",
            frame: { v: 1, at: "now", type: "sync.started", mode: "full", afterRecordId: null },
          });
          publish();
          expect(cache.get("a")).toBeUndefined();
          await task.checkpoint("incomplete full sync");
          state = reducer(state, {
            type: "frame",
            frame: {
              v: 1,
              at: "now",
              type: "history.record",
              record: history("a", ["new"]).records[0] ?? expect.fail("fixture record missing"),
              headId: "new",
              retiredBlockIds: [],
            },
          });
          publish();
          expect(cache.get("a")).toBeUndefined();
          await task.checkpoint("sync completion");
          state = reducer(state, {
            type: "frame",
            frame: { v: 1, at: "now", type: "sync.completed", headId: "new" },
          });
          publish();
        },
      },
      {
        name: "late-replica",
        f: async (task) => {
          await task.checkpoint("lagging HTTP response");
          state = reducer(state, {
            type: "history_refreshed",
            view: history(),
            epoch: refreshEpoch,
          });
          publish();
        },
      },
    ]);
    if (result.isErr()) throw result.error;
    expect([...state.records.keys()]).toEqual(["new"]);
    expect(cache.get("a")?.afterRecordId).toBe("new");
  });
});
