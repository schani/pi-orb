import { UsageViewSchema } from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { usageFixture } from "../../dev/usage-fixture.ts";

const start = Date.UTC(2026, 9, 13);
const keys = ["input", "output", "cacheRead", "cacheWrite", "calls"] as const;
describe("mock usage", () => {
  it("provides deterministic, varying data with reconciled breakdowns and rankings", () => {
    const edges = Array.from({ length: 97 }, (_, i) => start + i * 900000);
    const data = usageFixture(edges);
    expect(Check(UsageViewSchema, data)).toBe(true);
    expect(data).toEqual(usageFixture(edges));
    expect(data.summary.calls).toBeGreaterThan(0);
    expect(new Set(data.buckets.map((row) => row.use)).size).toBe(6);
    expect(new Set(data.buckets.map((row) => row.model)).size).toBeGreaterThan(1);
    expect(data.orbs).toHaveLength(5);
    expect(data.orbs.some((row) => row.name === null)).toBe(true);
    expect(
      new Set(data.buckets.filter((row) => row.use === "root").map((row) => row.input)).size,
    ).toBeGreaterThan(1);
    for (const orb of data.orbs) {
      const rows = data.buckets.filter((row) => row.orbId === orb.id);
      expect(rows.length).toBeGreaterThan(0);
      for (const key of keys) expect(rows.reduce((sum, row) => sum + row[key], 0)).toBe(orb[key]);
    }
    for (const key of keys) {
      expect(data.buckets.reduce((sum, row) => sum + row[key], 0)).toBe(data.summary[key]);
      expect(data.orbs.reduce((sum, row) => sum + row[key], 0)).toBe(data.summary[key]);
    }
  });
  it("uses half-open windows and preserves totals when a range is split", () => {
    const end = start + 3600000,
      middle = start + 1800000;
    const all = usageFixture([start, middle, end]);
    const left = usageFixture([start, middle]),
      right = usageFixture([middle, end]);
    for (const key of keys) expect(left.summary[key] + right.summary[key]).toBe(all.summary[key]);
    expect(usageFixture([0, 900000]).summary.calls).toBe(0);
  });
});
