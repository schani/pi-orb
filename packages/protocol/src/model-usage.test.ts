import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parseUsageQuery, UsageViewSchema } from "./model-usage.ts";

describe("usage read contract", () => {
  it("accepts bounded increasing bucket edges, including a short final bucket", () => {
    expect(parseUsageQuery({ boundaries: "[0,900000,900001]" })._unsafeUnwrap()).toEqual([
      0, 900000, 900001,
    ]);
    expect(
      Check(UsageViewSchema, {
        boundaries: [0, 900000],
        summary: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
        buckets: [],
        orbs: [],
      }),
    ).toBe(true);
  });
  it.each([
    {},
    { boundaries: "broken" },
    { boundaries: "{}" },
    { boundaries: "[0]" },
    { boundaries: "[0,0]" },
    { boundaries: "[2,1]" },
    { boundaries: "[-1,1]" },
    { boundaries: "[0,0.5]" },
    { boundaries: "[0,900000]", owner: "someone" },
    { boundaries: JSON.stringify([0, 26 * 3600000]) },
    { boundaries: JSON.stringify(Array.from({ length: 189 }, (_, i) => i * 900000)) },
    { boundaries: JSON.stringify(Array.from({ length: 188 }, (_, i) => i * 25 * 3600000)) },
    { boundaries: JSON.stringify([8640000000000000, 8640000000000001]) },
  ])("rejects malformed or unbounded reads: %j", (query) => {
    expect(parseUsageQuery(query)._unsafeUnwrapErr().type).toBe("usage_request_invalid");
  });
  it("rejects unsafe or negative totals in successful responses", () => {
    const response = {
      boundaries: [0, 1],
      summary: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
      buckets: [],
      orbs: [],
    };
    expect(Check(UsageViewSchema, response)).toBe(false);
    response.summary.input = Number.MAX_SAFE_INTEGER + 1;
    expect(Check(UsageViewSchema, response)).toBe(false);
  });
});
