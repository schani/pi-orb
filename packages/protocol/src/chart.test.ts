import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  CHART_MAX_SOURCE_CHARS,
  ChartSpecSchema,
  parseChartSpec,
} from "./chart.ts";

const line = {
  kind: "line",
  title: "checkout-api p95 latency",
  unit: "ms",
  source: "https://app.datadoghq.com/metric/explorer",
  series: [
    {
      name: "p95",
      points: [
        ["2026-10-13T18:00:00.000Z", 180],
        [1792000800000, null],
        [1792001100000, 410],
      ],
    },
  ],
  markers: [{ at: "2026-10-13T18:05:00.000Z", label: "deploy a41c9e2" }],
  thresholds: [{ value: 300, label: "SLO 300 ms" }],
};

function message(value: unknown): string {
  const parsed = parseChartSpec(value);
  if (parsed.isOk()) throw new Error("expected rejection");
  expect(parsed.error.type).toBe("chart_invalid");
  return parsed.error.message;
}

describe("parseChartSpec", () => {
  it("normalizes timestamps to epoch milliseconds and drops null points", () => {
    const parsed = parseChartSpec(line)._unsafeUnwrap();
    expect(parsed).toEqual({
      kind: "line",
      title: "checkout-api p95 latency",
      unit: "ms",
      source: "https://app.datadoghq.com/metric/explorer",
      series: [
        {
          name: "p95",
          points: [
            [Date.parse("2026-10-13T18:00:00.000Z"), 180],
            [1792001100000, 410],
          ],
        },
      ],
      markers: [{ at: Date.parse("2026-10-13T18:05:00.000Z"), label: "deploy a41c9e2" }],
      thresholds: [{ value: 300, label: "SLO 300 ms" }],
    });
    expect(Check(ChartSpecSchema, parsed)).toBe(true);
  });

  it("accepts a bar chart", () => {
    const bars = {
      kind: "bar",
      title: "slowest endpoints",
      bars: [
        { label: "POST /checkout", value: 412 },
        { label: "GET /cart", value: 141 },
      ],
    };
    expect(parseChartSpec(bars)._unsafeUnwrap()).toEqual(bars);
  });

  it("accepts a band around a line and normalizes its timestamps", () => {
    const band = {
      kind: "line",
      title: "latency",
      series: [
        {
          name: "p50",
          points: [[1, 180]],
          band: {
            name: "p5–p95",
            points: [
              ["2026-10-13T18:00:00.000Z", 90, 240],
              [2, null, 1],
            ],
          },
        },
      ],
    };
    expect(parseChartSpec(band)._unsafeUnwrap()).toMatchObject({
      series: [
        {
          band: { name: "p5–p95", points: [[Date.parse("2026-10-13T18:00:00.000Z"), 90, 240]] },
        },
      ],
    });
    expect(
      message({
        ...band,
        series: [{ ...band.series[0], band: { name: "b", points: [[1, 3, 2]] } }],
      }),
    ).toMatch(/band "b" has a low above its high/);
    expect(
      message({
        ...band,
        series: [{ ...band.series[0], band: { name: "p50", points: [[1, 1, 2]] } }],
      }),
    ).toMatch(/"p50" appears twice/);
  });

  it("accepts a histogram of raw values and bounds it", () => {
    const histogram = {
      kind: "histogram",
      title: "latency distribution",
      unit: "ms",
      series: [
        { name: "before", values: [120, 180] },
        { name: "after", values: [130, 420] },
      ],
    };
    expect(parseChartSpec(histogram)._unsafeUnwrap()).toEqual(histogram);
    expect(
      message({ ...histogram, series: [...histogram.series, { name: "c", values: [1] }] }),
    ).toMatch(/series/);
    expect(
      message({ ...histogram, series: [{ name: "a", values: [Number.POSITIVE_INFINITY] }] }),
    ).toMatch(/values/);
    expect(
      message({
        ...histogram,
        series: [{ name: "a", values: Array.from({ length: CHART_MAX_POINTS + 1 }, (_, i) => i) }],
      }),
    ).toMatch(new RegExp(`${CHART_MAX_POINTS} points`));
  });

  it("accepts a timeline and normalizes span times", () => {
    const timeline = {
      kind: "timeline",
      title: "Deploy run",
      spans: [
        { lane: "setup", label: "queued", start: 0, end: 38_000, state: "queued" },
        {
          lane: "image",
          label: "build",
          start: "2026-10-13T18:00:00.000Z",
          end: "2026-10-13T18:07:51.000Z",
          critical: true,
        },
      ],
    };
    expect(parseChartSpec(timeline)._unsafeUnwrap()).toEqual({
      ...timeline,
      spans: [
        timeline.spans[0],
        {
          ...timeline.spans[1],
          start: Date.parse("2026-10-13T18:00:00.000Z"),
          end: Date.parse("2026-10-13T18:07:51.000Z"),
        },
      ],
    });
    expect(message({ ...timeline, spans: [{ lane: "a", label: "b", start: 2, end: 1 }] })).toMatch(
      /span "b" ends before it starts/,
    );
    expect(
      message({ ...timeline, spans: [{ lane: "a", label: "b", start: 1, end: 2, state: "ok" }] }),
    ).toMatch(/state/);
  });

  it("accepts a heatmap whose values match its labels", () => {
    const heatmap = {
      kind: "heatmap",
      title: "CI failures",
      x: ["00", "01"],
      y: ["Mon", "Tue", "Wed"],
      values: [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    };
    expect(parseChartSpec(heatmap)._unsafeUnwrap()).toEqual(heatmap);
    expect(message({ ...heatmap, values: [[0, 1]] })).toMatch(/3 rows of 2 values/);
    expect(message({ ...heatmap, values: [[0, 1], [2, 3], [4]] })).toMatch(/3 rows of 2 values/);
    expect(
      message({
        ...heatmap,
        values: [
          [0, -1],
          [2, 3],
          [4, 5],
        ],
      }),
    ).toMatch(/non-negative/);
  });

  it("accepts a compare chart and rejects rows it cannot place on a ratio scale", () => {
    const compare = {
      kind: "compare",
      title: "p95 per-job service time",
      unit: "s",
      from: "TS 5.9",
      to: "tsrs 0.18",
      better: "lower",
      rows: [
        { label: "1 concurrent", from: 3.97, to: 0.42 },
        { label: "2 concurrent", from: 6.97, to: 0.73 },
      ],
    };
    expect(parseChartSpec(compare)._unsafeUnwrap()).toEqual(compare);
    expect(parseChartSpec({ ...compare, tolerance: 10 }).isOk()).toBe(true);
    expect(message({ ...compare, rows: [{ label: "a", from: 0, to: 1 }] })).toMatch(/positive/);
    expect(
      message({
        ...compare,
        rows: [
          { label: "a", from: 1, to: 2 },
          { label: "a", from: 1, to: 2 },
        ],
      }),
    ).toMatch(/row "a" appears twice/);
    expect(message({ ...compare, to: "TS 5.9" })).toMatch(/from and to/);
    expect(message({ ...compare, better: "faster" })).toMatch(/better/);
  });

  it("tells the script to fold or split more than six series", () => {
    const series = Array.from({ length: CHART_MAX_SERIES + 1 }, (_, i) => ({
      name: `s${i}`,
      points: [[1, i]],
    }));
    expect(message({ kind: "line", title: "t", series })).toMatch(/at most 6 series.*fold/i);
  });

  it("rejects unknown fields, so a spec cannot point the browser at remote data", () => {
    expect(message({ ...line, data: { url: "https://example.com/data.json" } })).toMatch(/data/);
  });

  it("rejects a missing title and an empty bar list", () => {
    expect(message({ kind: "line", series: line.series })).toMatch(/title/);
    expect(message({ kind: "bar", title: "t", bars: [] })).toMatch(/bars/);
  });

  it("rejects source links that are not http(s)", () => {
    expect(message({ ...line, source: "javascript:alert(1)" })).toMatch(/source/);
  });

  it("rejects unparseable timestamps and non-finite values", () => {
    expect(
      message({ kind: "line", title: "t", series: [{ name: "a", points: [["noon", 1]] }] }),
    ).toMatch(/timestamp/);
    expect(message({ kind: "bar", title: "t", bars: [{ label: "a", value: Number.NaN }] })).toMatch(
      /bars/,
    );
  });

  it("rejects duplicate series names, which would merge in the tooltip and hover", () => {
    expect(
      message({
        kind: "line",
        title: "t",
        series: [
          { name: "a", points: [[1, 1]] },
          { name: "a", points: [[1, 2]] },
        ],
      }),
    ).toMatch(/series "a" appears twice/);
  });

  it("rejects a series left empty after dropping nulls", () => {
    expect(
      message({ kind: "line", title: "t", series: [{ name: "a", points: [[1, null]] }] }),
    ).toMatch(/series "a" has no points/);
  });

  it("bounds the stored size", () => {
    const points = Array.from({ length: CHART_MAX_POINTS + 1 }, (_, i) => [i, i]);
    expect(message({ kind: "line", title: "t", series: [{ name: "a", points }] })).toMatch(
      new RegExp(`${CHART_MAX_POINTS} points`),
    );
    expect(
      message({
        kind: "bar",
        title: "t",
        bars: Array.from({ length: 40 }, (_, i) => ({ label: "x".repeat(60) + i, value: i })),
        unit: "ms",
        source: `https://example.com/${"a".repeat(CHART_MAX_SOURCE_CHARS)}`,
      }),
    ).toMatch(/source/);
  });
});
