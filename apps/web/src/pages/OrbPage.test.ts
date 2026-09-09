import { describe, expect, it } from "vitest";
import { initialState, isLiveBusy, reducer } from "./OrbPage.tsx";

function busyState() {
  const state = reducer(initialState("orb-1"), {
    type: "connection_status",
    status: "open",
  });
  return reducer(state, {
    type: "frame",
    frame: {
      v: 1,
      at: "2026-09-08T00:00:00Z",
      type: "runtime.event",
      event: { type: "status", activity: "busy", operationId: "op-1" },
    },
  });
}

describe("OrbPage live activity", () => {
  it.each(["closed", "retrying", "connecting"] as const)(
    "invalidates activity on %s without discarding output or the draft",
    (status) => {
      const before = { ...busyState(), composerText: "keep this draft" };
      const after = reducer(before, { type: "connection_status", status });
      expect(after.activity).toBeNull();
      expect(after.operationId).toBeNull();
      expect(after.records).toBe(before.records);
      expect(after.liveBlocks).toBe(before.liveBlocks);
      expect(after.tools).toBe(before.tools);
      expect(after.composerText).toBe("keep this draft");
    },
  );

  it("does not revive stale busy activity when the socket reopens", () => {
    const disconnected = reducer(busyState(), { type: "connection_status", status: "retrying" });
    const reopened = reducer(disconnected, { type: "connection_status", status: "open" });
    expect(isLiveBusy("running", reopened)).toBe(false);
    const refreshed = reducer(reopened, {
      type: "frame",
      frame: {
        v: 1,
        at: "2026-09-08T00:00:01Z",
        type: "runtime.event",
        event: { type: "status", activity: "busy", operationId: "op-2" },
      },
    });
    expect(isLiveBusy("running", refreshed)).toBe(true);
  });

  it.each(["stopping", "stopped", "starting", "failed", "archived", undefined] as const)(
    "hides the cursor for %s even before socket cleanup",
    (lifecycle) => expect(isLiveBusy(lifecycle, busyState())).toBe(false),
  );

  it.each(["closed", "retrying", "connecting"] as const)(
    "hides the cursor for %s even with stale busy activity",
    (connection) => expect(isLiveBusy("running", { ...busyState(), connection })).toBe(false),
  );

  it("shows busy only for live busy output, not idle or unknown activity", () => {
    const state = busyState();
    expect(isLiveBusy("running", state)).toBe(true);
    expect(isLiveBusy("running", { ...state, activity: "idle" })).toBe(false);
    expect(isLiveBusy("running", { ...state, activity: null })).toBe(false);
  });
});
