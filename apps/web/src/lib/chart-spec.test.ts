import type {
  BarChart,
  CompareChart,
  HeatmapChart,
  HistogramChart,
  LineChart,
  TimelineChart,
} from "@pi-orb/protocol";
import { compile } from "vega-lite";
import { describe, expect, it } from "vitest";
import {
  barChartSpec,
  CHART_CONFIG,
  compareRows,
  compareScale,
  compareSpec,
  durationTicks,
  formatDuration,
  formatValue,
  heatmapSpec,
  histogramBins,
  histogramSpec,
  latestValue,
  lineChartSpec,
  niceTop,
  seriesStyles,
  sparklineSpec,
  spreadLabels,
  timelineSpec,
  tooltipRows,
} from "./chart-spec.ts";

type Layer = {
  mark?: { type?: string };
  layer?: Layer[];
  encoding?: Record<string, unknown>;
  data?: { values?: unknown[] };
};
const flatten = (layers: Layer[]): Layer[] =>
  layers.flatMap((layer) => [layer, ...flatten(layer.layer ?? [])]);
const marks = (spec: { layer?: Layer[] }, type: string) =>
  flatten(spec.layer ?? []).filter((layer) => layer.mark?.type === type);

const isComb = (layer: Layer) =>
  (layer.encoding?.["y2"] as { value?: number } | undefined)?.value !== undefined;

const line = (count: number, extra: Partial<LineChart> = {}): LineChart => ({
  kind: "line",
  title: "p95 by zone",
  unit: "ms",
  series: Array.from({ length: count }, (_, i) => ({
    name: `zone-${i}`,
    points: [
      [1_000, 100 + i],
      [2_000, 200 + 10 * i],
    ],
  })),
  ...extra,
});

describe("series styles", () => {
  it("draws up to three series in ink weights and dashes", () => {
    expect(seriesStyles(1)).toEqual({ colors: ["#000"], dash: [[]] });
    expect(seriesStyles(3)).toEqual({
      colors: ["#000", "#555", "#777"],
      dash: [[], [6, 3], [1.5, 3]],
    });
  });

  it("switches four to six series to the validated hues in series order", () => {
    expect(seriesStyles(4).colors).toEqual(["#2a78d6", "#eb6834", "#4a3aa7", "#1baf7a"]);
    expect(seriesStyles(6)).toEqual({
      colors: ["#2a78d6", "#eb6834", "#4a3aa7", "#1baf7a", "#c2418a", "#7a5c00"],
      dash: [[], [], [], [], [], []],
    });
  });
});

describe("value formatting", () => {
  it.each([
    ["ms", 412.4, "412 ms"],
    ["ms", 1234, "1,234 ms"],
    ["%", 2.034, "2.03%"],
    ["%", 0.5, "0.5%"],
    [undefined, 12.345, "12.3"],
  ] as const)("%s %d → %s", (unit, value, expected) => {
    expect(formatValue(unit, value)).toBe(expected);
  });
});

describe("axis headroom", () => {
  it.each([
    [582, 600],
    [2.3, 2.5],
    [470, 500],
    [0, 1],
  ])("niceTop(%d) = %d", (value, expected) => {
    expect(niceTop(value)).toBe(expected);
  });
});

describe("end-label spreading", () => {
  it("spreads crowded labels apart while keeping their order", () => {
    expect(spreadLabels([110, 100, 105], 180)).toEqual([126, 100, 113]);
  });

  it("pushes labels back up from the bottom edge", () => {
    expect(spreadLabels([178, 179], 180)).toEqual([167, 180]);
  });

  it("leaves separated labels alone", () => {
    expect(spreadLabels([20, 90, 160], 180)).toEqual([20, 90, 160]);
  });
});

describe("line chart spec", () => {
  it("opts into compact unit-free y labels without changing default labels or exact tooltips", () => {
    const input = line(1, {
      unit: "tokens",
      series: [{ name: "Cached input", points: [[1_000, 100_000_001]] }],
    });
    for (const narrow of [false, true]) {
      const compact = lineChartSpec(input, { narrow, height: 180, yAxisFormat: ".3~s" });
      const plain = lineChartSpec(input, { narrow, height: 180 });
      expect(marks(compact, "line")[0]?.encoding?.["y"]).toMatchObject({
        axis: { format: ".3~s" },
      });
      expect(marks(compact, "line")[0]?.encoding?.["y"]).not.toHaveProperty("axis.labelExpr");
      expect(marks(plain, "line")[0]?.encoding?.["y"]).toMatchObject({
        axis: { labelExpr: 'datum.label + " tokens"' },
      });
      expect(() => compile(compact as Parameters<typeof compile>[0])).not.toThrow();
    }
    expect(tooltipRows(input, { time: "00:00", "Cached input": "100,000,001" })).toEqual([
      { label: "time", value: "00:00" },
      { label: "Cached input", value: "100,000,001 tokens" },
    ]);
    const milliseconds = lineChartSpec(line(1), { narrow: false, height: 180 });
    expect(marks(milliseconds, "line")[0]?.encoding?.["y"]).toMatchObject({
      axis: { labelExpr: 'datum.label + " ms"' },
    });
  });

  it("labels caller-supplied positions over dense unlabeled ticks", () => {
    const ticks = Array.from({ length: 183 }, (_, i) => Date.UTC(2026, 3, 13 + i, 17));
    const labels = Array.from({ length: 6 }, (_, i) => Date.UTC(2026, 4 + i, 1));
    const input = line(2, {
      series: [0, 1].map((i) => ({ name: `series-${i}`, points: ticks.map((t) => [t, i + 1]) })),
    });
    for (const narrow of [false, true]) {
      const spec = lineChartSpec(input, {
        narrow,
        height: 280,
        xAxis: { ticks, labels, format: "%b" },
      });
      const axis = (marks(spec, "line")[0]?.encoding?.["x"] as { axis: object } | undefined)?.axis;
      expect(axis).toMatchObject({
        values: labels,
        tickCount: labels.length,
        format: "%b",
        labelOverlap: "greedy",
        labelSeparation: 12,
        ticks: false,
      });
      expect(axis).not.toHaveProperty("labelExpr");
      const comb = flatten(spec.layer ?? []).find(isComb);
      expect(comb?.mark?.type).toBe("rule");
      expect(comb?.data?.values).toEqual(ticks.map((t) => ({ t })));
      expect(() => compile(spec as Parameters<typeof compile>[0])).not.toThrow();
    }
    const plain = lineChartSpec(line(2), { narrow: false, height: 180 });
    const defaultAxis = (
      marks(plain, "line")[0]?.encoding?.["x"] as { axis: Record<string, unknown> } | undefined
    )?.axis;
    expect(defaultAxis).toBeDefined();
    expect(defaultAxis).not.toHaveProperty("values");
    expect(flatten(plain.layer ?? []).some(isComb)).toBe(false);
  });

  it("names multiple series at their line ends and lets a hovered name isolate its line", () => {
    const spec = lineChartSpec(line(3), { narrow: false, height: 180 });
    expect(spec.params).toEqual([{ name: "hl", value: null }]);
    const labels = marks(spec, "text").filter((layer) => layer.encoding?.["text"]);
    expect(JSON.stringify(labels)).toContain("label");
    const lines = marks(spec, "line");
    expect(JSON.stringify(lines[0]?.encoding?.["opacity"])).toContain("datum.s == hl");
  });

  it("keeps actions out of Vega data and exposes actionable single-series labels", () => {
    const input = line(3);
    const seriesActions = new Map([
      ["zone-0", { href: "/orbs/a%2Fb" }],
      ["zone-1", { onSelect: () => {} }],
    ]);
    const spec = lineChartSpec(input, { narrow: false, height: 180, seriesActions });
    const label = flatten(spec.layer ?? []).find(
      (layer) => layer.encoding?.["text"] && (layer as { name?: string }).name === "end_labels",
    );
    expect(label).toBeDefined();
    expect(label?.encoding?.["href"]).toBeUndefined();
    expect(label?.data?.values).toBeUndefined();
    expect(JSON.stringify(spec)).not.toMatch(/href|onSelect/);
    expect(JSON.stringify(input)).not.toMatch(/href|onSelect/);
    expect(() => compile(spec as Parameters<typeof compile>[0])).not.toThrow();
    const single = lineChartSpec(line(1), {
      narrow: false,
      height: 180,
      seriesActions: new Map([["zone-0", { href: "/orbs/a" }]]),
    });
    expect(JSON.stringify(single)).toContain('"field":"label"');
  });

  it("replaces end labels with the key at phone width", () => {
    const spec = lineChartSpec(line(3), { narrow: true, height: 180 });
    expect(JSON.stringify(spec)).not.toContain('"field":"label"');
  });

  it("gives a single series an end dot but no end label", () => {
    const spec = lineChartSpec(line(1), { narrow: false, height: 180 });
    expect(marks(spec, "point").length).toBeGreaterThan(0);
    expect(JSON.stringify(spec)).not.toContain('"field":"label"');
  });

  it("never filters a layer down to empty data, which would give Vega an infinite time extent", () => {
    const spec = lineChartSpec(line(2), { narrow: false, height: 180 });
    expect(JSON.stringify(spec)).not.toContain('"filter"');
    expect(JSON.stringify(spec)).not.toMatch(/"x":\{[^}]*"scale"/);
    const hover = flatten(spec.layer ?? []).filter((layer) =>
      JSON.stringify(layer.encoding?.["opacity"] ?? "").includes('"param":"hover"'),
    );
    expect(hover.map((layer) => layer.mark?.type).sort()).toEqual(["point", "rule"]);
    expect(spec.autosize).toEqual({ type: "fit-x", contains: "padding" });
  });

  it("draws markers and thresholds, with the y axis covering the threshold", () => {
    const spec = lineChartSpec(
      line(1, {
        markers: [{ at: 1_500, label: "deploy a41c9e2" }],
        thresholds: [{ value: 1_000, label: "SLO 1 s" }],
      }),
      { narrow: false, height: 180 },
    );
    expect(JSON.stringify(spec)).toContain("deploy a41c9e2");
    expect(JSON.stringify(spec)).toContain("SLO 1 s");
    expect(JSON.stringify(spec)).toContain('"domain":[0,1200]');
  });
});

const banded = line(1, {
  series: [
    {
      name: "p50",
      points: [
        [1_000, 180],
        [2_000, 190],
      ],
      band: {
        name: "p5–p95",
        points: [
          [1_000, 90, 240],
          [2_000, 92, 2_000],
        ],
      },
    },
  ],
});
const histogram: HistogramChart = {
  kind: "histogram",
  title: "latency",
  unit: "ms",
  series: [
    { name: "before", values: [100, 150, 160, 170, 240] },
    { name: "after", values: [110, 150, 165, 420, 430] },
  ],
};
const timeline: TimelineChart = {
  kind: "timeline",
  title: "Deploy run",
  spans: [
    { lane: "setup", label: "queued", start: 0, end: 38_000, state: "queued" },
    { lane: "setup", label: "npm ci", start: 38_000, end: 104_000, critical: true },
    { lane: "e2e", label: "webkit", start: 104_000, end: 150_000, state: "failed" },
    { lane: "image", label: "build", start: 104_000, end: 612_000, critical: true },
  ],
};
const heatmap: HeatmapChart = {
  kind: "heatmap",
  title: "CI failures",
  unit: "failures",
  x: ["00", "01", "02"],
  y: ["Mon", "Tue"],
  values: [
    [0, 1, 9],
    [2, 0, 4],
  ],
};

describe("band", () => {
  it("draws the range behind its line, scales the y axis to cover it and lists it on hover", () => {
    const spec = lineChartSpec(banded, { narrow: false, height: 180 });
    const kinds = flatten(spec.layer ?? []).map((layer) => layer.mark?.type);
    expect(kinds.indexOf("area")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("area")).toBeLessThan(kinds.indexOf("line"));
    expect(JSON.stringify(spec)).toContain('"domain":[0,2500]');
    expect(JSON.stringify(spec)).toContain('"title":"p5–p95\\u0000lo"');
  });

  it("lists the range after the series in the tooltip", () => {
    const rows = tooltipRows(banded, {
      time: "13:15",
      p50: 180,
      "p5–p95\u0000lo": 90,
      "p5–p95\u0000hi": "1,240",
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["time", "13:15"],
      ["p50", "180 ms"],
      ["p5–p95", "90–1,240 ms"],
    ]);
  });
});

describe("histogram", () => {
  it("bins every series on one shared, nice grid", () => {
    const { step, lo, hi, series } = histogramBins(histogram);
    expect(step).toBe(20);
    expect([lo, hi]).toEqual([100, 440]);
    for (const { bins, values } of series) {
      expect(bins).toHaveLength((hi - lo) / step);
      expect(bins.reduce((sum, n) => sum + n, 0)).toBe(values.length);
    }
    expect(series[1]?.percentiles).toEqual({ p50: 165, p95: 430, p99: 430 });
  });

  it("fills the last series, outlines the earlier one and isolates either from its label", () => {
    const spec = histogramSpec(histogram, { narrow: false, height: 160 });
    expect(spec.params).toEqual([{ name: "hl", value: null }]);
    expect(marks(spec, "bar").length).toBeGreaterThan(0);
    expect(JSON.stringify(marks(spec, "line"))).toContain("step-after");
    expect(JSON.stringify(spec)).toContain("datum.s == hl");
    const labels = flatten(spec.layer ?? []).find(
      (layer) => (layer as { name?: string }).name === "end_labels",
    );
    expect(JSON.stringify(labels?.data)).toContain('"lv"');
    expect(JSON.stringify(histogramSpec(histogram, { narrow: true, height: 160 }))).not.toContain(
      "end_labels",
    );
  });

  it("lists the bin range, then every series count", () => {
    const rows = tooltipRows(histogram, { range: "100–120 ms", before: 1, after: 1 });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["range", "100–120 ms"],
      ["before", "1"],
      ["after", "1"],
    ]);
  });
});

describe("timeline", () => {
  it("formats durations at the scale of the run", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(8_400)).toBe("8.4s");
    expect(formatDuration(28_000)).toBe("28s");
    expect(formatDuration(66_000)).toBe("1m 06s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
    expect(durationTicks(872_000)).toEqual([
      0, 120_000, 240_000, 360_000, 480_000, 600_000, 720_000, 840_000,
    ]);
  });

  it("keeps lanes in first-appearance order with one bar per span", () => {
    const spec = timelineSpec(timeline);
    expect(spec.height).toBe(3 * 22);
    expect(JSON.stringify(spec)).toContain('"domain":["setup","e2e","image"]');
    expect(marks(spec, "bar")).toHaveLength(1);
    expect((spec.data as { values: unknown[] }).values).toHaveLength(4);
  });

  it("shows the run's total duration in the folded row", () => {
    expect(latestValue(timeline)).toBe("10m 12s");
  });
});

describe("heatmap", () => {
  it("sizes rows, shades by square root and keeps zero cells pale", () => {
    const spec = heatmapSpec(heatmap);
    expect(spec.height).toBe(2 * 22);
    expect(JSON.stringify(spec)).toContain('"type":"sqrt"');
    expect(JSON.stringify(spec)).toContain("datum.v == 0");
    expect(tooltipRows(heatmap, { cell: "Mon · 02", value: "9 failures" })).toEqual([
      { label: "Mon · 02", value: "9 failures" },
    ]);
  });
});

const compare: CompareChart = {
  kind: "compare",
  title: "benchmarks",
  unit: "ms",
  from: "main",
  to: "feat",
  better: "lower",
  rows: [
    { label: "render", from: 184, to: 61 },
    { label: "layout", from: 7.4, to: 7.6 },
    { label: "cold start", from: 420, to: 512 },
  ],
};

describe("compare", () => {
  it("names each change as a multiple in the better direction, within tolerance as same", () => {
    expect(compareRows(compare).map((row) => [row.state, row.change, row.percent])).toEqual([
      ["better", "3× better", "-67%"],
      ["same", "same", "+3%"],
      ["worse", "1.22× worse", "+22%"],
    ]);
    const throughput = { ...compare, better: "higher" as const, tolerance: 25 };
    expect(compareRows(throughput).map((row) => row.state)).toEqual(["worse", "same", "same"]);
  });

  it("uses a log scale when values span a decade, otherwise a linear one from zero", () => {
    expect(compareScale([7.4, 512])).toEqual({
      type: "log",
      domain: [1, 600],
      ticks: [1, 2, 5, 10, 20, 50, 100, 200, 500],
    });
    expect(compareScale([0.26, 0.31])).toEqual({
      type: "linear",
      domain: [0, 0.4],
      ticks: [0, 0.1, 0.2, 0.3, 0.4],
    });
  });

  it("labels rows on the axis when wide and stacks label over dumbbell at phone width", () => {
    const wide = compareSpec(compare, { narrow: false });
    expect(wide.height).toBe(3 * 20);
    expect(JSON.stringify(wide)).toContain('"main → feat"');
    const narrow = compareSpec(compare, { narrow: true });
    expect(narrow.height).toBe(3 * 38);
    expect(marks(narrow, "tick")).toHaveLength(1);
    expect(JSON.stringify(narrow)).toContain('"axis":null');
  });

  it("lists baseline, candidate and change on hover, and counts breaches when folded", () => {
    const rows = tooltipRows(compare, {
      row: "cold start",
      from: "420 ms",
      to: "512 ms",
      change: "+22% · 1.22× worse",
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["cold start", ""],
      ["main", "420 ms"],
      ["feat", "512 ms"],
      ["change", "+22% · 1.22× worse"],
    ]);
    expect(latestValue(compare)).toBe("1 worse");
    expect(latestValue({ ...compare, rows: compare.rows.slice(0, 2) })).toBeNull();
  });
});

describe("bar and sparkline specs", () => {
  const bars: BarChart = {
    kind: "bar",
    title: "slowest",
    unit: "ms",
    bars: [
      { label: "POST /checkout", value: 412 },
      { label: "GET /cart", value: 141 },
    ],
  };

  it("keeps bars in the given order with values at the tips", () => {
    const spec = barChartSpec(bars);
    expect(spec.autosize).toEqual({ type: "fit-x", contains: "padding" });
    expect(JSON.stringify(spec)).toContain('"sort":null');
    expect(marks(spec, "text")).toHaveLength(1);
  });

  it("builds a sparkline for every kind", () => {
    expect(sparklineSpec(bars).mark).toMatchObject({ type: "bar" });
    expect(sparklineSpec(line(4)).mark).toMatchObject({ type: "line" });
    expect(sparklineSpec(histogram).mark).toMatchObject({ type: "bar" });
    expect(sparklineSpec(timeline).mark).toMatchObject({ type: "bar" });
    expect(sparklineSpec(heatmap).mark).toMatchObject({ type: "rect" });
    expect(sparklineSpec(compare).mark).toMatchObject({ type: "bar" });
  });
});

describe("tooltip rows", () => {
  it("lists time first, then every series by value, highest first", () => {
    const rows = tooltipRows(line(3), {
      time: "13:15",
      "zone-0": 338,
      "zone-1": 403,
      "zone-2": "256",
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["time", "13:15"],
      ["zone-1", "403 ms"],
      ["zone-0", "338 ms"],
      ["zone-2", "256 ms"],
    ]);
    expect(rows[1]).toMatchObject({ color: "#555", dash: [6, 3] });
  });
});

describe("latest value", () => {
  it("is shown in the folded row only for a single line", () => {
    expect(latestValue(line(1))).toBe("200 ms");
    expect(latestValue(line(2))).toBeNull();
  });
});

describe("vega-lite compilation", () => {
  const bars: BarChart = { kind: "bar", title: "t", unit: "ms", bars: [{ label: "a", value: 1 }] };
  it.each([
    ["bar chart", barChartSpec(bars)],
    ["line chart, one series", lineChartSpec(line(1), { narrow: false, height: 180 })],
    ["line chart, six series", lineChartSpec(line(6), { narrow: false, height: 180 })],
    ["line chart at phone width", lineChartSpec(line(3), { narrow: true, height: 180 })],
    ["band", lineChartSpec(banded, { narrow: false, height: 180 })],
    ["histogram", histogramSpec(histogram, { narrow: false, height: 160 })],
    ["histogram at phone width", histogramSpec(histogram, { narrow: true, height: 160 })],
    ["timeline", timelineSpec(timeline)],
    ["heatmap", heatmapSpec(heatmap)],
    ["compare", compareSpec(compare, { narrow: false })],
    ["compare at phone width", compareSpec(compare, { narrow: true })],
    ["bar sparkline", sparklineSpec(bars)],
    ["line sparkline", sparklineSpec(line(4))],
    ["histogram sparkline", sparklineSpec(histogram)],
    ["timeline sparkline", sparklineSpec(timeline)],
    ["heatmap sparkline", sparklineSpec(heatmap)],
    ["compare sparkline", sparklineSpec(compare)],
  ])("compiles the %s without warnings", (_name, spec) => {
    const warnings: string[] = [];
    const logger = {
      level: () => logger,
      warn: (...args: unknown[]) => {
        warnings.push(args.join(" "));
        return logger;
      },
      info: () => logger,
      debug: () => logger,
      error: (...args: unknown[]) => {
        warnings.push(args.join(" "));
        return logger;
      },
    };
    compile({ ...spec, config: CHART_CONFIG } as never, { logger: logger as never });
    expect(warnings).toEqual([]);
  });
});
