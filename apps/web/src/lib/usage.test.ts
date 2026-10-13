import type { UsageView } from "@pi-orb/protocol";
import { describe, expect, it } from "vitest";
import {
  cacheShare,
  formatUsageCount,
  totalTokens,
  usageBoundaries,
  usageRankings,
  usageTimeline,
} from "./usage.ts";

const at = Date.UTC(2026, 9, 13);
const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
const data: UsageView = {
  boundaries: [at, at + 900000, at + 1800000],
  summary: { input: 30, output: 7, cacheRead: 80, cacheWrite: 10, calls: 3 },
  buckets: [
    {
      at,
      use: "root",
      provider: "p",
      model: "m",
      input: 10,
      output: 2,
      cacheRead: 80,
      cacheWrite: 10,
      calls: 2,
    },
    {
      at: at + 900000,
      use: "subagent",
      provider: "p",
      model: "m",
      input: 20,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 1,
    },
  ],
  orbs: [
    { id: "a", name: "Same", input: 10, output: 2, cacheRead: 80, cacheWrite: 10, calls: 2 },
    { id: "b", name: "Same", input: 20, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1 },
  ],
};
describe("usage presentation", () => {
  it("keeps large summary counts compact", () => {
    expect(formatUsageCount(39_300_292)).toBe("39.3M");
    expect(formatUsageCount(10_000_000_000)).toBe("10B");
    expect(formatUsageCount(100)).toBe("100");
  });
  it("builds dense rolling periods and clamps calendar month subtraction", () => {
    const now = new Date(2026, 9, 13, 10).getTime();
    for (const [period, n] of [
      ["day", 96],
      ["week", 168],
      ["month", 120],
      ["six_months", 183],
    ] as const) {
      const boundaries = usageBoundaries(period, now);
      expect(boundaries).toHaveLength(n + 1);
      expect(boundaries.at(-1)).toBe(now);
      expect(boundaries.every((v, i) => i === 0 || v > (boundaries[i - 1] ?? 0))).toBe(true);
    }
    const end = new Date(2026, 2, 31, 10).getTime();
    expect(usageBoundaries("month", end)[0]).toBe(new Date(2026, 1, 28, 10).getTime());
    expect(usageBoundaries("six_months", now)[0]).toBe(new Date(2026, 3, 13, 10).getTime());
  });
  it("sums volume including cache and weights cache share by prompt tokens", () => {
    expect(totalTokens(data.summary)).toBe(127);
    expect(cacheShare(data.summary)).toBeCloseTo(80 / 120);
    expect(cacheShare(empty)).toBeNull();
  });
  it("fills every interval, preserves token composition and reconciles use/model lines", () => {
    const token = usageTimeline(data, "token_kind");
    expect(token.series).toHaveLength(4);
    expect(token.series.find((s) => s.name === "Cached input")?.points).toEqual([
      [at, 80],
      [at + 900000, 0],
    ]);
    for (const breakdown of ["token_kind", "use", "model"] as const) {
      const chart = usageTimeline(data, breakdown);
      expect(chart.series.every((s) => s.points.length === 2)).toBe(true);
      expect(chart.series.flatMap((s) => s.points).reduce((sum, point) => sum + point[1], 0)).toBe(
        127,
      );
    }
  });
  it("limits model lines to five leaders plus Other without discarding usage", () => {
    const buckets = Array.from({ length: 8 }, (_, i) => ({
      ...data.buckets[0]!,
      model: "m" + i,
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }));
    const chart = usageTimeline({ ...data, buckets }, "model");
    expect(chart.series).toHaveLength(6);
    expect(chart.series.find((s) => s.name === "Other")?.points).toEqual([
      [at, 30],
      [at + 900000, 0],
    ]);
    expect(chart.series.flatMap((s) => s.points).reduce((sum, p) => sum + p[1], 0)).toBe(80);
  });
  it("ranks the selected measure, keeps equal names distinct, and represents empty data", () => {
    const totals = usageRankings(data, "total");
    const output = usageRankings(data, "output");
    expect(totals.orbs?.bars.map((b) => b.value)).toEqual([102, 25]);
    expect(output.orbs?.bars.map((b) => b.value)).toEqual([5, 2]);
    expect(new Set(output.orbs?.bars.map((b) => b.label)).size).toBe(2);
    expect(output.uses?.bars.map((b) => b.label)).toEqual(["Subagent", "Root"]);
    expect(usageRankings({ ...data, summary: empty, buckets: [], orbs: [] }, "total")).toEqual({
      orbs: null,
      uses: null,
    });
  });
});
