import type { BarChart, ChartSpec, LineChart } from "@pi-orb/protocol";

/** Pure Vega-Lite builders for transcript charts (docs/web-ui.md, transcript charts). */

export interface VegaLayer {
  [key: string]: unknown;
  mark?: { type?: string; [key: string]: unknown };
  layer?: VegaLayer[];
  encoding?: Record<string, unknown>;
}
export interface VegaSpec extends VegaLayer {
  params?: { name: string; value: unknown }[];
}

const INK = "#000";
const MUTED = "#555";
const HAIRLINE = "#999";
const GRID = "#e6e6e6";
const BAD = "#b42318";
const INK_COLORS = ["#000", "#555", "#777"];
const INK_DASH = [[], [6, 3], [1.5, 3]];
/** Validated against #fff for colour-blind and normal-vision separation across all pairs. */
const HUES = ["#2a78d6", "#eb6834", "#4a3aa7", "#1baf7a", "#c2418a", "#7a5c00"];
const LABEL_GAP = 13;
/** Opacity of lines that are not the isolated series. */
const DIMMED = 0.12;

export const CHART_CONFIG = {
  background: null,
  font: "JetBrains Mono",
  view: { stroke: null },
  axis: {
    labelFont: "JetBrains Mono",
    labelFontSize: 11,
    labelColor: MUTED,
    gridColor: GRID,
    gridWidth: 1,
    domainColor: INK,
    domainWidth: 1,
    tickColor: INK,
    tickSize: 4,
    labelPadding: 4,
    title: null,
  },
  axisY: { domain: false, ticks: false, tickCount: 4, labelPadding: 8 },
  axisX: { grid: false, labelFlush: true, tickCount: 6 },
  axisBand: { domain: false, ticks: false, labelColor: INK, labelFontSize: 11, labelPadding: 8 },
  line: { strokeWidth: 2, strokeCap: "round", strokeJoin: "round" },
  bar: { cornerRadius: 0, color: INK },
  point: { filled: true, size: 56, stroke: "#fff", strokeWidth: 2, opacity: 1 },
  text: { font: "JetBrains Mono", fontSize: 11, color: INK },
  rule: { color: INK, strokeWidth: 1 },
  legend: { disable: true },
} as const;

/** Up to three series in ink weights and dashes; four to six in hues, in series order. */
export function seriesStyles(count: number): { colors: string[]; dash: number[][] } {
  return count <= 3
    ? { colors: INK_COLORS.slice(0, count), dash: INK_DASH.slice(0, count) }
    : { colors: HUES.slice(0, count), dash: HUES.slice(0, count).map(() => []) };
}

export function formatValue(unit: string | undefined, value: number): string {
  const magnitude = Math.abs(value);
  const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
  return unit === undefined || unit === ""
    ? number
    : unit === "%"
      ? `${number}%`
      : `${number} ${unit}`;
}

export function niceTop(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => k * magnitude >= value - 1e-9);
  return Number(((step ?? 10) * magnitude).toPrecision(12));
}

/** Pixel positions → non-overlapping positions within [0, height], same order. */
export function spreadLabels(ys: readonly number[], height: number, gap = LABEL_GAP): number[] {
  const order = ys.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    const [above, current] = [order[k - 1], order[k]];
    if (above && current) current.y = Math.max(current.y, above.y + gap);
  }
  const lowest = order.at(-1);
  if (lowest) lowest.y = Math.min(lowest.y, height);
  for (let k = order.length - 2; k >= 0; k--) {
    const [current, below] = [order[k], order[k + 1]];
    if (current && below) current.y = Math.min(current.y, below.y - gap);
  }
  const out = [...ys];
  for (const { y, index } of order) out[index] = y;
  return out;
}

const HL = "hl == null || datum.s == hl";
const isolate = (dimmed: number) => ({ condition: { test: HL, value: 1 }, value: dimmed });
const timeFormat = (spec: LineChart) => {
  const times = spec.series.flatMap((series) => series.points.map(([t]) => t));
  return Math.max(...times) - Math.min(...times) > 86_400_000 ? "%b %d %H:%M" : "%H:%M";
};

/** Local UI actions, never part of the protocol's persisted ChartSpec. */
export type ChartSeriesAction = { href: string } | { onSelect: () => void };
export type ChartSeriesActions = ReadonlyMap<string, ChartSeriesAction>;

export interface ChartXAxis {
  /** Unlabeled. */
  readonly ticks: readonly number[];
  /** Vega drops labels that would overlap. */
  readonly labels: readonly number[];
  readonly format: string;
}

export function lineChartSpec(
  spec: LineChart,
  {
    narrow,
    height,
    xAxis,
    seriesActions,
  }: {
    narrow: boolean;
    height: number;
    xAxis?: ChartXAxis;
    seriesActions?: ChartSeriesActions;
  },
): VegaSpec {
  const names = spec.series.map((series) => series.name);
  const many = names.length > 1;
  const labels = !narrow && (many || spec.series.some((s) => seriesActions?.has(s.name)));
  const { colors, dash } = seriesStyles(names.length);
  const rows = spec.series.flatMap((series, index) =>
    series.points.map(([t, v]) => ({ t, v, s: series.name, k: `s${index}` })),
  );
  const values = [
    ...rows.map((row) => row.v),
    ...(spec.thresholds ?? []).map((item) => item.value),
  ];
  const low = Math.min(0, ...values);
  const lo = low < 0 ? -niceTop(-low * 1.12) : 0;
  const high = Math.max(...values);
  const hi = high > 0 ? niceTop(high * 1.12) : lo < 0 ? 0 : 1;
  const pixel = (v: number) => height * (1 - (v - lo) / (hi - lo));
  // The schema guarantees every series at least one point.
  const last = spec.series.flatMap((series) => {
    const end = series.points.at(-1);
    return end === undefined
      ? []
      : [
          {
            t: end[0],
            v: end[1],
            s: series.name,
            label: `${series.name} ${formatValue(spec.unit, end[1])}`,
          },
        ];
  });
  const placed = spreadLabels(
    last.map((item) => pixel(item.v)),
    height,
  );
  const ends = last.map((item, index) => ({
    ...item,
    lv: lo + (1 - (placed[index] ?? pixel(item.v)) / height) * (hi - lo),
  }));
  const leaders = ends.some((item) => Math.abs(pixel(item.lv) - pixel(item.v)) > 1);
  const format = timeFormat(spec);
  const x = {
    field: "t",
    type: "temporal",
    title: null,
    axis: {
      format,
      ...(narrow ? { tickCount: 3 } : {}),
      ...(xAxis === undefined
        ? {}
        : {
            values: [...xAxis.labels],
            tickCount: xAxis.labels.length,
            format: xAxis.format,
            labelOverlap: "greedy",
            labelSeparation: 12,
            ticks: false,
            labelPadding: CHART_CONFIG.axis.tickSize + CHART_CONFIG.axis.labelPadding,
          }),
    },
  };
  const y = { field: "v", type: "quantitative" };
  const color = {
    field: "s",
    type: "nominal",
    scale: { domain: names, range: colors },
    legend: null,
  };
  const unitSuffix =
    spec.unit === undefined || spec.unit === "" ? "" : spec.unit === "%" ? "%" : ` ${spec.unit}`;
  const first = Math.min(...rows.map((row) => row.t));
  const layer: VegaLayer[] = [];
  for (const threshold of spec.thresholds ?? [])
    layer.push({
      data: { values: [{ y: threshold.value }] },
      layer: [
        {
          mark: { type: "rule", color: BAD },
          encoding: { y: { field: "y", type: "quantitative" } },
        },
        {
          mark: { type: "text", color: BAD, align: "left", baseline: "bottom", dx: 2, dy: -2 },
          encoding: {
            y: { field: "y", type: "quantitative" },
            x: { datum: first, type: "temporal" },
            text: { value: threshold.label },
          },
        },
      ],
    });
  if (xAxis !== undefined)
    layer.push({
      name: "x_ticks",
      data: { values: xAxis.ticks.map((t) => ({ t })) },
      mark: { type: "rule" },
      encoding: {
        x: { field: "t", type: "temporal" },
        y: { value: height },
        y2: { value: height + CHART_CONFIG.axis.tickSize },
      },
    });
  for (const marker of spec.markers ?? [])
    layer.push({
      data: { values: [{ t: marker.at }] },
      layer: [
        {
          mark: { type: "rule", strokeDash: [2, 2] },
          encoding: { x: { field: "t", type: "temporal" } },
        },
        {
          mark: { type: "text", color: MUTED, align: "right", baseline: "top", dx: -4, y: 0 },
          encoding: {
            x: { field: "t", type: "temporal" },
            text: {
              value: narrow ? (marker.label.split(" ").at(-1) ?? marker.label) : marker.label,
            },
          },
        },
      ],
    });
  layer.push({
    data: { values: rows },
    mark: { type: "line" },
    encoding: {
      x,
      y: {
        ...y,
        axis: { labelExpr: `datum.label + ${JSON.stringify(unitSuffix)}` },
        scale: { domain: [lo, hi], nice: false },
      },
      color,
      strokeDash: {
        field: "s",
        type: "nominal",
        scale: { domain: names, range: dash },
        legend: null,
      },
      opacity: isolate(DIMMED),
    },
  });
  layer.push({
    data: { values: ends },
    layer: [
      { mark: { type: "point", size: 40 }, encoding: { x, y, color, opacity: isolate(DIMMED) } },
      ...(labels && leaders
        ? [
            {
              mark: { type: "rule", color: HAIRLINE, xOffset: 5, x2Offset: 13 },
              encoding: { x, x2: { field: "t" }, y, y2: { field: "lv" }, opacity: isolate(0.25) },
            },
          ]
        : []),
      ...(labels
        ? [
            {
              name: "end_labels",
              mark: { type: "text", align: "left", dx: leaders ? 16 : 8, cursor: "default" },
              encoding: {
                x,
                y: { field: "lv", type: "quantitative" },
                text: { field: "label" },
                opacity: isolate(0.3),
              },
              // A selection makes Vega hit-test the labels; isolation itself is driven through `hl`.
              params: [
                {
                  name: "label",
                  select: { type: "point", fields: ["s"], on: "pointerover", clear: "pointerout" },
                },
              ],
            },
          ]
        : []),
    ],
  });
  // Invisible points pinned to one y give nearest-time hit strips; rules have no y to build them from.
  layer.push({
    data: { values: rows },
    transform: [{ pivot: "k", value: "v", groupby: ["t"] }],
    mark: { type: "point", opacity: 0, size: 1 },
    encoding: {
      x,
      y: { value: height / 2 },
      tooltip: [
        { field: "t", type: "temporal", title: "time", format },
        ...names.map((name, index) => ({ field: `s${index}`, type: "quantitative", title: name })),
      ],
    },
    params: [
      {
        name: "hover",
        select: {
          type: "point",
          fields: ["t"],
          nearest: true,
          on: "pointerover",
          clear: "pointerout",
        },
      },
    ],
  });
  layer.push({
    data: { values: rows },
    // Hover layers keep their data and toggle opacity: an empty layer gives Vega an infinite extent.
    transform: [{ aggregate: [{ op: "count", as: "n" }], groupby: ["t"] }],
    mark: { type: "rule" },
    encoding: { x, opacity: { condition: { param: "hover", empty: false, value: 1 }, value: 0 } },
  });
  layer.push({
    data: { values: rows },
    mark: { type: "point" },
    encoding: {
      x,
      y,
      color,
      opacity: { condition: { param: "hover", empty: false, value: 1 }, value: 0 },
    },
  });
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height,
    autosize: { type: "fit-x", contains: "padding" },
    padding: { top: 4, right: 4, bottom: 0, left: 0 },
    params: [{ name: "hl", value: null }],
    layer,
  };
}

export function barChartSpec(spec: BarChart): VegaSpec {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    // A numeric height (20px per bar) rather than a step, so fitting the width leaves height alone.
    height: spec.bars.length * 20,
    autosize: { type: "fit-x", contains: "padding" },
    padding: { top: 0, right: 4, bottom: 0, left: 0 },
    data: {
      values: spec.bars.map((bar) => ({
        k: bar.label,
        v: bar.value,
        text: formatValue(spec.unit, bar.value),
      })),
    },
    encoding: {
      y: { field: "k", type: "nominal", sort: null, title: null },
      x: { field: "v", type: "quantitative", axis: null, scale: { zero: true, nice: false } },
    },
    layer: [
      {
        mark: { type: "bar", size: 10 },
        encoding: {
          opacity: { condition: { param: "bar", empty: false, value: 0.72 }, value: 1 },
          tooltip: [
            { field: "k", title: "label" },
            { field: "v", title: "value" },
          ],
        },
        params: [
          { name: "bar", select: { type: "point", on: "pointerover", clear: "pointerout" } },
        ],
      },
      { mark: { type: "text", align: "left", dx: 6 }, encoding: { text: { field: "text" } } },
    ],
  };
}

export function sparklineSpec(spec: ChartSpec): VegaSpec {
  const frame = {
    width: "container",
    height: 16,
    padding: 0,
    autosize: { type: "fit", contains: "padding" },
  };
  if (spec.kind === "bar")
    return {
      ...frame,
      data: { values: spec.bars.map((bar) => ({ k: bar.label, v: bar.value })) },
      mark: { type: "bar", color: INK, cornerRadius: 0 },
      encoding: {
        x: { field: "k", type: "nominal", sort: null, axis: null, scale: { paddingInner: 0.25 } },
        y: { field: "v", type: "quantitative", axis: null },
      },
    };
  const names = spec.series.map((series) => series.name);
  const { colors, dash } = seriesStyles(names.length);
  return {
    ...frame,
    data: {
      values: spec.series.flatMap((series) =>
        series.points.map(([t, v]) => ({ t, v, s: series.name })),
      ),
    },
    mark: { type: "line", strokeWidth: 1.5 },
    encoding: {
      x: { field: "t", type: "temporal", axis: null },
      y: { field: "v", type: "quantitative", axis: null, scale: { zero: true } },
      color: { field: "s", type: "nominal", scale: { domain: names, range: colors }, legend: null },
      strokeDash: {
        field: "s",
        type: "nominal",
        scale: { domain: names, range: dash.map((pattern) => pattern.map((length) => length / 2)) },
        legend: null,
      },
    },
  };
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
  dash?: number[];
}

/** Time first, then every series at that time, highest value first. */
export function tooltipRows(spec: ChartSpec, value: Record<string, unknown>): TooltipRow[] {
  if (spec.kind === "bar")
    return [
      { label: String(value["label"]), value: formatValue(spec.unit, Number(value["value"])) },
    ];
  const { colors, dash } = seriesStyles(spec.series.length);
  const many = spec.series.length > 1;
  return [
    { label: "time", value: String(value["time"]) },
    ...spec.series
      .map((series, index) => ({
        series,
        index,
        v: Number(String(value[series.name]).replace(/,/g, "")),
      }))
      .filter((entry) => Number.isFinite(entry.v))
      .sort((a, b) => b.v - a.v)
      .map(({ series, index, v }) => ({
        label: series.name,
        value: formatValue(spec.unit, v),
        ...(many ? { color: colors[index] ?? INK, dash: dash[index] ?? [] } : {}),
      })),
  ];
}

/** The folded row carries the latest value only when one line names it unambiguously. */
export function latestValue(spec: ChartSpec): string | null {
  if (spec.kind !== "line" || spec.series.length !== 1) return null;
  const end = spec.series[0]?.points.at(-1);
  return end === undefined ? null : formatValue(spec.unit, end[1]);
}
