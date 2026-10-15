import type { BarChart, LineChart } from "@pi-orb/protocol";
import { compile } from "vega-lite";
import { describe, expect, it } from "vitest";
import {
  barChartSpec,
  CHART_CONFIG,
  formatValue,
  latestValue,
  lineChartSpec,
  niceTop,
  seriesStyles,
  sparklineSpec,
  spreadLabels,
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

  it("builds a sparkline for both kinds", () => {
    expect(sparklineSpec(bars).mark).toMatchObject({ type: "bar" });
    expect(sparklineSpec(line(4)).mark).toMatchObject({ type: "line" });
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
    ["bar sparkline", sparklineSpec(bars)],
    ["line sparkline", sparklineSpec(line(4))],
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
