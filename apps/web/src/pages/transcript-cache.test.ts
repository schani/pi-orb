import { expect, it } from "vitest";
import { snapshotFromHistory } from "../lib/transcript-cache.ts";
import { history } from "../testkit/transcript.ts";
import { initialState, reducer } from "./OrbPage.tsx";

it("restores only transcript state by reference into a disconnected conversation", () => {
  const snapshot = snapshotFromHistory(history());
  const state = reducer(initialState("a"), { type: "history_restored", snapshot });
  expect(state.records).toBe(snapshot.records);
  expect(state.sessionId).toBe("session");
  expect(state.cacheReady).toBe(true);
  expect(state.connection).toBe("closed");
  expect(state.settings).toBeNull();
  expect(state.welcome).toBeNull();
  expect(state.synced).toBe(false);
  expect(state.liveBlocks.size).toBe(0);
  expect(state.subagents).toEqual([]);
});

it.each(["session", "replacement"])(
  "welcome for %s clears the live roster independently of cached session identity",
  (sessionId) => {
    const restored = reducer(initialState("a"), { type: "history_loaded", view: history() });
    const before = {
      ...restored,
      subagents: [{ id: "child", description: "Work", phase: "running" as const }],
    };
    const after = reducer(before, {
      type: "frame",
      frame: {
        v: 1,
        at: "now",
        type: "server.welcome",
        orbId: "a",
        sessionId,
        connectionId: "connection",
        runtimeInstanceId: "runtime",
        capabilities: [],
        limits: { maxIncomingFrameBytes: 10000, maxPromptBytes: 1000 },
      },
    });
    expect(after.subagents).toEqual([]);
    expect(after.sessionId).toBe(sessionId);
    if (sessionId === "session") expect(after.records).toBe(before.records);
    else {
      expect(after.records.size).toBe(0);
      expect(after.afterRecordId).toBeNull();
      expect(after.cacheReady).toBe(false);
    }
  },
);

it("same-session lagging replica preserves newer live records; empty uninitialized replica pins nothing", () => {
  const state = reducer(initialState("a"), {
    type: "history_loaded",
    view: history("a", ["one", "two"]),
  });
  const merged = reducer(state, {
    type: "history_refreshed",
    view: history(),
    epoch: state.historyEpoch,
  });
  expect([...merged.records.keys()]).toEqual(["one", "two"]);
  expect(merged.afterRecordId).toBe("two");
  const empty = { ...history("a", []), session: null };
  const unchanged = reducer(merged, {
    type: "history_refreshed",
    view: empty,
    epoch: merged.historyEpoch,
  });
  expect(unchanged.sessionId).toBe("session");
  expect(unchanged.afterRecordId).toBe("two");
});

it("repairs a missing ancestor even when the cursor and head already match", () => {
  const complete = history("a", ["one", "middle", "three"]);
  const state = reducer(initialState("a"), {
    type: "history_loaded",
    view: { ...complete, records: complete.records.filter((record) => record.id !== "middle") },
  });
  const repaired = reducer(state, {
    type: "history_refreshed",
    view: complete,
    epoch: state.historyEpoch,
  });

  expect([...repaired.records.keys()]).toEqual(["one", "middle", "three"]);
  expect(repaired.records.get("one")).toBe(state.records.get("one"));
  expect(repaired.records.get("three")).toBe(state.records.get("three"));
});

it("ignores repeated authoritative snapshots without rebuilding transcript state", () => {
  const state = reducer(initialState("a"), { type: "history_loaded", view: history() });
  const refreshed = reducer(state, {
    type: "history_refreshed",
    view: history(),
    epoch: state.historyEpoch,
  });

  expect(refreshed).toBe(state);
  expect(refreshed.records).toBe(state.records);
});

it("applies repair side effects without rebuilding an unchanged transcript", () => {
  const state = reducer(initialState("a"), { type: "history_loaded", view: history() });
  const withTransientState = {
    ...state,
    liveBlocks: new Map([
      [
        "live",
        {
          blockId: "live",
          blockType: "text" as const,
          text: "partial",
          revision: 1,
        },
      ],
    ]),
    historyError: { type: "network" as const, message: "temporary" },
  };
  const repaired = reducer(withTransientState, {
    type: "history_refreshed",
    view: history(),
    epoch: state.historyEpoch,
  });

  expect(repaired).not.toBe(withTransientState);
  expect(repaired.records).toBe(state.records);
  expect(repaired.liveBlocks.size).toBe(0);
  expect(repaired.historyError).toBeNull();
});

it("updates changed authoritative history while retaining immutable record identities", () => {
  const state = reducer(initialState("a"), { type: "history_loaded", view: history() });
  const existing = state.records.get("one");
  const refreshed = reducer(state, {
    type: "history_refreshed",
    view: history("a", ["one", "two"]),
    epoch: state.historyEpoch,
  });

  expect(refreshed).not.toBe(state);
  expect([...refreshed.records.keys()]).toEqual(["one", "two"]);
  expect(refreshed.records.get("one")).toBe(existing);
});

it("a confirmed new replica session replaces rather than concatenates histories", () => {
  const state = reducer(initialState("a"), { type: "history_loaded", view: history() });
  const changed = reducer(state, {
    type: "history_refreshed",
    view: history("a", ["different"], "new-session"),
    epoch: state.historyEpoch,
  });
  expect([...changed.records.keys()]).toEqual(["different"]);
  expect(changed.sessionId).toBe("new-session");
});

it("starting a connection fences an already-issued HTTP refresh even after it disconnects", () => {
  let state = reducer(initialState("a"), { type: "history_loaded", view: history() });
  const epoch = state.historyEpoch;
  state = reducer(state, { type: "connection_status", status: "connecting" });
  state = reducer(state, { type: "connection_status", status: "closed" });
  expect(
    reducer(state, {
      type: "history_refreshed",
      view: history("a", ["old"], "old-session"),
      epoch,
    }),
  ).toBe(state);
});
