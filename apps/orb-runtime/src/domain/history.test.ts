import type { HistoryRecord } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import { computePullHistory } from "./history.ts";
import type { HarnessSnapshot } from "./types.ts";

function makeRecords(n: number): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (let i = 1; i <= n; i++) {
    records.push({
      id: `rec-${i}`,
      parentId: i === 1 ? null : `rec-${i - 1}`,
      timestamp: `t${i}`,
      overflow: { native: { i } },
      type: "message",
      role: i % 2 === 1 ? "user" : "assistant",
      content: [{ type: "text", text: `m${i}` }],
    });
  }
  return records;
}

function snapshot(n: number): HarnessSnapshot {
  const records = makeRecords(n);
  return {
    orbId: "orb-a",
    runtimeInstanceId: "run-1",
    activity: "idle",
    session: { id: "sess-1", overflow: { native: {} } },
    records,
    headId: records.at(-1)?.id ?? null,
  };
}

describe("computePullHistory", () => {
  it("returns everything from the beginning without after", () => {
    const result = computePullHistory(snapshot(3), { after: null, limit: 100 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.records.map((r) => r.id)).toEqual(["rec-1", "rec-2", "rec-3"]);
    expect(result.value.cursor).toBe("rec-3");
    expect(result.value.headId).toBe("rec-3");
    expect(result.value.orbId).toBe("orb-a");
  });

  it("returns records strictly after the cursor", () => {
    const result = computePullHistory(snapshot(5), { after: "rec-2", limit: 100 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.records.map((r) => r.id)).toEqual(["rec-3", "rec-4", "rec-5"]);
    expect(result.value.cursor).toBe("rec-5");
  });

  it("echoes the cursor for an empty response", () => {
    const result = computePullHistory(snapshot(3), { after: "rec-3", limit: 100 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.records).toEqual([]);
    expect(result.value.cursor).toBe("rec-3");
    expect(result.value.headId).toBe("rec-3");
  });

  it("clamps to limit and reports the head within the returned prefix only", () => {
    const result = computePullHistory(snapshot(10), { after: "rec-2", limit: 3 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.records.map((r) => r.id)).toEqual(["rec-3", "rec-4", "rec-5"]);
    expect(result.value.cursor).toBe("rec-5");
    // The true head rec-10 is beyond the batch; headId must stay within it.
    expect(result.value.headId).toBe("rec-5");
  });

  it("rejects an unknown cursor with cursor_not_found", () => {
    const result = computePullHistory(snapshot(3), { after: "rec-99", limit: 100 });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("cursor_not_found");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("rejects out-of-range limits", () => {
    expect(computePullHistory(snapshot(3), { after: null, limit: 0 }).isErr()).toBe(true);
    expect(computePullHistory(snapshot(3), { after: null, limit: 501 }).isErr()).toBe(true);
    const error = computePullHistory(snapshot(3), { after: null, limit: 501 });
    if (error.isErr()) expect(error.error.code).toBe("invalid_request");
  });

  it("handles an empty session", () => {
    const result = computePullHistory(snapshot(0), { after: null, limit: 100 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.records).toEqual([]);
    expect(result.value.cursor).toBeNull();
    expect(result.value.headId).toBeNull();
  });

  it("is stable across repeated identical requests", () => {
    const snap = snapshot(4);
    const a = computePullHistory(snap, { after: "rec-1", limit: 2 });
    const b = computePullHistory(snap, { after: "rec-1", limit: 2 });
    expect(a).toEqual(b);
  });
});
