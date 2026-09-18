import type { OrbView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  canStopOrb,
  initialState,
  isLiveBusy,
  missingResourceReducer,
  orbLifecycleStatus,
  reducer,
  sleepWaitingNotice,
} from "./OrbPage.tsx";

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

it("keeps missing sticky when stale success publishes before effect cleanup", () => {
  const afterMissing = missingResourceReducer(false, "missing");
  expect(missingResourceReducer(afterMissing, "found")).toBe(true);
});

describe("scheduled sleep lifecycle status", () => {
  const at = Date.parse("2026-09-17T00:00:00.000Z");
  const orb = (fields: Partial<OrbView> & { state: OrbView["state"] }) => fields as OrbView;

  it("keeps the current lifecycle visible with the pending sleep deadline", () => {
    expect(
      orbLifecycleStatus(
        orb({ state: "running", sleepUntil: "2026-09-17T01:00:00.000Z" } as Partial<OrbView> & {
          state: "running";
        }),
        at,
      ),
    ).toBe("running · sleep pending · wakes in 1h");
    expect(
      orbLifecycleStatus(
        orb({
          state: "running",
          activity: "busy",
          sleepUntil: "2026-09-17T01:00:00.000Z",
        } as Partial<OrbView> & { state: "running" }),
        at,
      ),
    ).toBe("running · busy · sleep pending · wakes in 1h");
  });

  it("shows a stopped pending sleep as sleeping without masking failures", () => {
    expect(
      orbLifecycleStatus(
        orb({ state: "stopped", sleepUntil: "2026-09-17T01:00:00.000Z" } as Partial<OrbView> & {
          state: "stopped";
        }),
        at,
      ),
    ).toBe("sleeping until 2026-09-17T01:00:00Z");
    expect(
      orbLifecycleStatus(
        orb({ state: "failed", sleepUntil: "2026-09-17T01:00:00.000Z" } as Partial<OrbView> & {
          state: "failed";
        }),
        at,
      ),
    ).toBe("failed");
  });

  it("surfaces upload-specific waiting detail supplied by the lifecycle", () => {
    expect(
      sleepWaitingNotice({
        type: "waiting_for_sleep",
        sleepUntil: "2026-09-17T01:00:00.000Z",
        phase: "waiting_for_idle",
        message: "Waiting for 2 pending uploads.",
      }),
    ).toBe("Sleep pending: Waiting for 2 pending uploads.");
  });
});

describe("OrbPage stop action", () => {
  const orb = (fields: Partial<OrbView> & { state: OrbView["state"] }) => fields as OrbView;

  it("does not stop an ordinarily stopped orb", () => {
    expect(canStopOrb(orb({ state: "stopped" }))).toBe(false);
  });

  it.each(["stopped", "failed"] as const)("cancels pending sleep while %s", (state) => {
    expect(canStopOrb(orb({ state, sleepUntil: "2026-09-17T01:00:00.000Z" }))).toBe(true);
  });

  it("interrupts a graceful sleep stop after its schedule was canceled", () => {
    expect(canStopOrb(orb({ state: "stopping", stopReason: "sleep" }))).toBe(true);
  });

  it("does not override an ordinary stop", () => {
    expect(canStopOrb(orb({ state: "stopping" }))).toBe(false);
  });

  it.each(["archiving", "deleting", "archived"] as const)(
    "does not stop terminal cleanup state %s",
    (state) =>
      expect(
        canStopOrb(orb({ state, sleepUntil: "2026-09-17T01:00:00.000Z", stopReason: "sleep" })),
      ).toBe(false),
  );
});

describe("OrbPage live activity", () => {
  it("replaces the child roster and invalidates it across disconnect and operation changes", () => {
    const children = [{ id: "child", description: "Check deployment", phase: "running" as const }];
    const frame = {
      v: 1 as const,
      at: "now",
      type: "runtime.event" as const,
      event: { type: "subagents" as const, operationId: "op-1", children },
    };
    const before = reducer(busyState(), { type: "frame", frame });
    expect(before.subagents).toEqual(children);
    const empty = reducer(before, {
      type: "frame",
      frame: { ...frame, event: { ...frame.event, children: [] } },
    });
    expect(empty.subagents).toEqual([]);
    expect(empty.activity).toBe("busy");
    const disconnected = reducer(before, { type: "connection_status", status: "retrying" });
    expect(disconnected.subagents).toEqual([]);
    expect(reducer(disconnected, { type: "connection_status", status: "open" }).subagents).toEqual(
      [],
    );
    const successor = reducer(before, {
      type: "frame",
      frame: { ...frame, event: { type: "operation_started", operationId: "op-2" } },
    });
    expect(successor.subagents).toEqual([]);
    expect(reducer(successor, { type: "frame", frame }).subagents).toEqual([]);
  });
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
    "hides the activity marker for %s even before socket cleanup",
    (lifecycle) => expect(isLiveBusy(lifecycle, busyState())).toBe(false),
  );

  it.each(["closed", "retrying", "connecting"] as const)(
    "hides the activity marker for %s even with stale busy activity",
    (connection) => expect(isLiveBusy("running", { ...busyState(), connection })).toBe(false),
  );

  it("shows busy only for live busy output, not idle or unknown activity", () => {
    const state = busyState();
    expect(isLiveBusy("running", state)).toBe(true);
    expect(isLiveBusy("running", { ...state, activity: "idle" })).toBe(false);
    expect(isLiveBusy("running", { ...state, activity: null })).toBe(false);
  });
});
