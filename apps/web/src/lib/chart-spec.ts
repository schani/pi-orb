import type {
  BarChart,
  ChartSpec,
  CompareChart,
  HeatmapChart,
  HistogramChart,
  LineChart,
  TimelineChart,
} from "@pi-orb/protocol";

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
const FILL = "#f2f2f2";
const PALE = "#d9d9d9";
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

const unitSuffix = (unit: string | undefined) =>
  unit === undefined || unit === "" ? "" : unit === "%" ? "%" : ` ${unit}`;
const short = (value: number) => formatValue(undefined, value);
/** Vega formats tooltip numbers with thousands separators. */
const number = (value: unknown) => Number(String(value).replace(/,/g, ""));

/** Tooltip titles of a band's ends; series names cannot collide with them. */
const bandTitle = (name: string, end: "lo" | "hi") => `${name}\u0000${end}`;

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

/** Pixel positions → at least `gap` apart and at most `height`, in input order. */
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
  const bands = spec.series.flatMap((series, index) =>
    (series.band?.points ?? []).map(([t, lo, hi]) => ({
      t,
      lo,
      hi,
      s: series.name,
      k: `s${index}`,
    })),
  );
  const values = [
    ...rows.map((row) => row.v),
    ...bands.map((row) => row.hi),
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
  if (bands.length > 0)
    layer.push({
      data: { values: bands },
      layer: [
        {
          mark: { type: "area", fillOpacity: 0.09 },
          encoding: {
            x,
            y: { field: "lo", type: "quantitative" },
            y2: { field: "hi" },
            color,
            opacity: isolate(DIMMED),
          },
        },
        ...["lo", "hi"].map((field) => ({
          mark: { type: "line", strokeWidth: 1, strokeOpacity: 0.35 },
          encoding: { x, y: { field, type: "quantitative" }, color, opacity: isolate(DIMMED) },
        })),
      ],
    });
  layer.push({
    data: { values: rows },
    mark: { type: "line" },
    encoding: {
      x,
      y: {
        ...y,
        axis: { labelExpr: `datum.label + ${JSON.stringify(unitSuffix(spec.unit))}` },
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
  const banded = spec.series.flatMap((series, index) =>
    series.band === undefined ? [] : [{ index, name: series.band.name }],
  );
  layer.push({
    data: {
      values: [
        ...rows,
        ...bands.flatMap((row) => [
          { t: row.t, v: row.lo, k: `${row.k}lo` },
          { t: row.t, v: row.hi, k: `${row.k}hi` },
        ]),
      ],
    },
    transform: [{ pivot: "k", value: "v", groupby: ["t"] }],
    mark: { type: "point", opacity: 0, size: 1 },
    encoding: {
      x,
      y: { value: height / 2 },
      tooltip: [
        { field: "t", type: "temporal", title: "time", format },
        ...names.map((name, index) => ({ field: `s${index}`, type: "quantitative", title: name })),
        ...banded.flatMap(({ index, name }) =>
          (["lo", "hi"] as const).map((end) => ({
            field: `s${index}${end}`,
            type: "quantitative",
            title: bandTitle(name, end),
          })),
        ),
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
    // Numeric height rather than a step, so fitting the width leaves height alone.
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

const PERCENTILES = { p50: 0.5, p95: 0.95, p99: 0.99 } as const;

/** Every series on one grid of about 30 nice-width bins, with its percentiles. */
export function histogramBins(spec: HistogramChart) {
  const all = spec.series.flatMap((series) => series.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const magnitude = 10 ** Math.floor(Math.log10((max - min) / 30 || 1));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * magnitude).find((k) => k >= (max - min) / 30) ?? 1;
  const lo = Math.floor(min / step) * step;
  const hi = Math.floor(max / step) * step + step;
  const count = Math.round((hi - lo) / step);
  return {
    step,
    lo,
    hi,
    series: spec.series.map((series) => {
      const bins = Array<number>(count).fill(0);
      for (const v of series.values) {
        const index = Math.min(count - 1, Math.floor((v - lo) / step));
        bins[index] = (bins[index] ?? 0) + 1;
      }
      const sorted = [...series.values].sort((a, b) => a - b);
      const at = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
      return {
        ...series,
        bins,
        percentiles: Object.fromEntries(
          Object.entries(PERCENTILES).map(([name, q]) => [name, at(q)]),
        ) as Record<keyof typeof PERCENTILES, number>,
      };
    }),
  };
}

/** The last series is filled ink; an earlier one is a grey step outline. */
export function histogramSpec(
  spec: HistogramChart,
  { narrow, height }: { narrow: boolean; height: number },
): VegaSpec {
  const { step, lo, hi, series } = histogramBins(spec);
  const last = series.length - 1;
  const colors = series.map((_, index) => (index === last ? INK : HAIRLINE));
  const top = niceTop(Math.max(...series.flatMap((item) => item.bins)) * 1.12);
  const x = {
    field: "x",
    type: "quantitative",
    scale: { domain: [lo, hi], nice: false, zero: false },
    axis: {
      grid: false,
      tickCount: narrow ? 3 : 6,
      labelExpr: `datum.label + ${JSON.stringify(unitSuffix(spec.unit))}`,
    },
  };
  const y = { type: "quantitative", scale: { domain: [0, top], nice: false } };
  const fade = (dimmed: number) => ({ condition: { test: HL, value: 1 }, value: dimmed });
  const layer: VegaLayer[] = [];
  series.forEach((item, index) => {
    const bins = item.bins.map((n, bin) => ({
      x: lo + bin * step,
      x2: lo + (bin + 1) * step,
      n,
      s: item.name,
    }));
    if (index === last)
      layer.push({
        data: { values: bins },
        mark: { type: "bar", color: INK, x2Offset: -1 },
        encoding: {
          x,
          x2: { field: "x2" },
          y: { ...y, field: "n" },
          y2: { datum: 0 },
          opacity: fade(DIMMED),
        },
      });
    else
      layer.push({
        data: {
          values: [
            { x: lo, n: 0, s: item.name },
            ...bins.map((bin) => ({ x: bin.x, n: bin.n, s: item.name })),
            { x: hi, n: bins.at(-1)?.n ?? 0, s: item.name },
            { x: hi, n: 0, s: item.name },
          ],
        },
        mark: { type: "line", interpolate: "step-after", color: HAIRLINE, strokeCap: "butt" },
        encoding: { x, y: { ...y, field: "n" }, opacity: fade(DIMMED) },
      });
    const ticks = Object.entries(item.percentiles).map(([name, value]) => ({
      x: value,
      name,
      s: item.name,
    }));
    layer.push({
      data: { values: ticks },
      layer: [
        {
          mark: { type: "rule", color: colors[index], strokeDash: [1, 3] },
          encoding: {
            x,
            y: { value: -6 + index * 12 },
            y2: { value: height },
            opacity: fade(DIMMED),
          },
        },
        // At phone width only the last series is named; earlier names would collide.
        ...(narrow && index !== last
          ? []
          : [
              {
                mark: {
                  type: "text",
                  align: "left",
                  dx: 3,
                  baseline: "middle",
                  color: index === last ? INK : MUTED,
                },
                encoding: {
                  x,
                  y: { value: -12 + index * 12 },
                  text: { field: "name" },
                  opacity: fade(0.3),
                },
              },
            ]),
      ],
    });
  });
  if (!narrow && series.length > 1)
    layer.push({
      name: "end_labels",
      data: {
        values: series.map((item, index) => ({
          s: item.name,
          // `lv` marks a hover target that isolates its series (chart-render.ts).
          lv: top * (index === last ? 0.85 : 0.5),
          label: `${item.name} p95 ${formatValue(spec.unit, item.percentiles.p95)}`,
          x: hi,
        })),
      },
      mark: { type: "text", align: "left", dx: 8, cursor: "default" },
      encoding: {
        x,
        y: { ...y, field: "lv" },
        text: { field: "label" },
        color: {
          field: "s",
          type: "nominal",
          scale: {
            domain: series.map((item) => item.name),
            range: [MUTED, INK].slice(-series.length),
          },
          legend: null,
        },
        opacity: fade(0.3),
      },
      params: [
        {
          name: "label",
          select: { type: "point", fields: ["s"], on: "pointerover", clear: "pointerout" },
        },
      ],
    });
  // Full-height bin strips carry the tooltip and the hover shade.
  layer.push({
    data: {
      values: Array.from({ length: series[0]?.bins.length ?? 0 }, (_, bin) => ({
        x: lo + bin * step,
        x2: lo + (bin + 1) * step,
        range: `${short(lo + bin * step)}–${formatValue(spec.unit, lo + (bin + 1) * step)}`,
        ...Object.fromEntries(series.map((item, index) => [`s${index}`, item.bins[bin] ?? 0])),
      })),
    },
    mark: { type: "rect", color: INK },
    encoding: {
      x,
      x2: { field: "x2" },
      y: { value: 0 },
      y2: { value: height },
      opacity: { condition: { param: "bin", empty: false, value: 0.06 }, value: 0 },
      tooltip: [
        { field: "range", title: "range" },
        ...series.map((item, index) => ({
          field: `s${index}`,
          type: "quantitative",
          title: item.name,
        })),
      ],
    },
    params: [{ name: "bin", select: { type: "point", on: "pointerover", clear: "pointerout" } }],
  });
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height,
    autosize: { type: "fit-x", contains: "padding" },
    padding: { top: 18, right: 4, bottom: 0, left: 0 },
    params: [{ name: "hl", value: null }],
    encoding: { y: { ...y, axis: { tickCount: 4 }, title: null } },
    layer,
  };
}

/** "450 ms", "8.4s", "28s", "1m 06s", "1h 04m". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds < 10 ? Number(seconds.toFixed(1)) : Math.round(seconds)}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${pad(Math.round(seconds % 60))}s`;
  return `${Math.floor(seconds / 3_600)}h ${pad(Math.round((seconds % 3_600) / 60))}m`;
}

const DURATION_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500]
  .concat([1, 2, 5, 10, 15, 30].map((s) => s * 1_000))
  .concat([1, 2, 5, 10, 15, 30].map((m) => m * 60_000))
  .concat([1, 2, 3, 6, 12, 24].map((h) => h * 3_600_000));

/** At most eight round elapsed-time ticks from zero. */
export function durationTicks(total: number): number[] {
  const step =
    DURATION_STEPS.find((k) => Math.floor(total / k) + 1 <= 8) ??
    86_400_000 * Math.ceil(total / 86_400_000 / 7);
  return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
}

const tickLabel = (ms: number) =>
  ms === 0
    ? "0"
    : ms < 1_000
      ? `${ms} ms`
      : ms < 60_000
        ? `${ms / 1_000}s`
        : ms < 3_600_000
          ? `${ms / 60_000}m`
          : `${ms / 3_600_000}h`;

const LANE = 22;
/** Fill and label colour by tooltip state. */
const SPAN_COLORS = {
  failed: [BAD, "#fff"],
  queued: ["#fff", MUTED],
  "critical path": [INK, "#fff"],
  "": [PALE, INK],
} as const;

/** Elapsed time from the first start; ink is the critical path, red failed, outlined queued. */
export function timelineSpec(spec: TimelineChart): VegaSpec {
  const origin = Math.min(...spec.spans.map((span) => span.start));
  const total = Math.max(...spec.spans.map((span) => span.end)) - origin;
  const lanes = [...new Set(spec.spans.map((span) => span.lane))];
  const ticks = durationTicks(total);
  const labels = Object.fromEntries(ticks.map((t) => [t, tickLabel(t)]));
  const spans = spec.spans.map((span) => {
    const duration = formatDuration(span.end - span.start);
    const look = span.state ?? (span.critical ? "critical path" : "");
    const [fill, ink] = SPAN_COLORS[look];
    return {
      lane: span.lane,
      a: span.start - origin,
      b: Math.max(span.end - origin, span.start - origin + 1),
      fill,
      ink,
      stroke: look === "queued" ? HAIRLINE : fill,
      text: `${span.label} ${duration}`,
      label: span.label,
      start: `+${formatDuration(span.start - origin)}`,
      duration,
      state: look,
    };
  });
  const x = {
    field: "a",
    type: "quantitative",
    scale: { domain: [0, total || 1], nice: false },
    axis: {
      values: ticks,
      // The configured tick count would otherwise thin the explicit values.
      tickCount: ticks.length,
      labelOverlap: "greedy",
      grid: true,
      labelExpr: `${JSON.stringify(labels)}[datum.value]`,
      labelFlush: true,
    },
    title: null,
  };
  const y = { field: "lane", type: "nominal", sort: null, scale: { domain: lanes }, title: null };
  // Mono 11px advances 6.6px per character.
  const fits = (text: string) =>
    `scale('x', datum.b) - scale('x', datum.a) >= length(${text}) * 6.6 + 10`;
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: lanes.length * LANE,
    autosize: { type: "fit-x", contains: "padding" },
    padding: { top: 0, right: 4, bottom: 0, left: 0 },
    data: { values: spans },
    encoding: { y },
    layer: [
      {
        mark: { type: "bar", size: LANE - 6, strokeWidth: 1 },
        encoding: {
          x,
          x2: { field: "b" },
          color: { field: "fill", type: "nominal", scale: null },
          stroke: { field: "stroke", type: "nominal", scale: null },
          opacity: { condition: { param: "span", empty: false, value: 0.72 }, value: 1 },
          tooltip: [
            { field: "lane", title: "lane" },
            { field: "label", title: "span" },
            { field: "start", title: "start" },
            { field: "duration", title: "duration" },
            { field: "state", title: "state" },
          ],
        },
        params: [
          { name: "span", select: { type: "point", on: "pointerover", clear: "pointerout" } },
        ],
      },
      {
        // Inside its bar: name and duration, else the name, else nothing; the tooltip has all.
        mark: {
          type: "text",
          align: "left",
          dx: 5,
          text: {
            expr: `${fits("datum.text")} ? datum.text : ${fits("datum.label")} ? datum.label : ''`,
          },
        },
        encoding: {
          x,
          color: { field: "ink", type: "nominal", scale: null },
        },
      },
    ],
  };
}

/** Ink density on a square-root scale; zero cells stay pale; exact values on hover. */
export function heatmapSpec(spec: HeatmapChart): VegaSpec {
  const max = Math.max(1, ...spec.values.flat());
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: spec.y.length * LANE,
    autosize: { type: "fit-x", contains: "padding" },
    padding: { top: 0, right: 4, bottom: 0, left: 0 },
    data: {
      values: spec.values.flatMap((row, j) =>
        row.map((v, i) => ({
          x: spec.x[i],
          y: spec.y[j],
          v,
          cell: `${spec.y[j]} · ${spec.x[i]}`,
          value: formatValue(spec.unit, v),
        })),
      ),
    },
    mark: { type: "rect", stroke: "#fff", strokeWidth: 1 },
    encoding: {
      x: {
        field: "x",
        type: "nominal",
        sort: null,
        scale: { domain: spec.x },
        title: null,
        axis: { labelAngle: 0, labelOverlap: true, labelColor: MUTED },
      },
      y: { field: "y", type: "nominal", sort: null, scale: { domain: spec.y }, title: null },
      color: { condition: { test: "datum.v == 0", value: FILL }, value: INK },
      opacity: {
        condition: { test: "datum.v == 0", value: 1 },
        field: "v",
        type: "quantitative",
        scale: { type: "sqrt", domain: [0, max], range: [0.08, 1] },
        legend: null,
      },
      tooltip: [
        { field: "cell", title: "cell" },
        { field: "value", title: "value" },
      ],
    },
  };
}

/** Per row: better, same (within tolerance of the baseline) or worse, and the change as text. */
export function compareRows(spec: CompareChart) {
  const tolerance = (spec.tolerance ?? 5) / 100;
  return spec.rows.map((row) => {
    const worseBy = (spec.better === "higher" ? row.from - row.to : row.to - row.from) / row.from;
    const state: keyof typeof COMPARE_COLORS =
      worseBy > tolerance ? "worse" : Math.abs(worseBy) <= tolerance ? "same" : "better";
    const ratio = row.to / row.from;
    const multiple = Math.max(ratio, 1 / ratio);
    const shown =
      multiple >= 10 ? Math.round(multiple) : Number(multiple.toFixed(multiple >= 2 ? 1 : 2));
    const percent = Math.round((ratio - 1) * 100);
    return {
      ...row,
      state,
      change: state === "same" ? "same" : `${shown}× ${state}`,
      percent: `${percent > 0 ? "+" : ""}${percent}%`,
    };
  });
}

/** Log when the values span a decade, so equal ratios get equal lengths; else linear from zero. */
export function compareScale(values: readonly number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max / min >= 10) {
    const lo = 10 ** Math.floor(Math.log10(min));
    const hi = niceTop(max * 1.05);
    const ticks: number[] = [];
    for (let decade = lo; decade <= hi; decade *= 10)
      for (const k of [1, 2, 5]) {
        const tick = Number((k * decade).toPrecision(12));
        if (tick <= hi) ticks.push(tick);
      }
    return { type: "log", domain: [lo, hi], ticks };
  }
  const hi = niceTop(max * 1.08);
  return {
    type: "linear",
    domain: [0, hi],
    ticks: [0, 1, 2, 3, 4].map((i) => Number(((hi * i) / 4).toPrecision(12))),
  };
}

const COMPARE_COLORS = {
  better: { line: INK, dot: INK, text: INK },
  same: { line: HAIRLINE, dot: MUTED, text: MUTED },
  worse: { line: BAD, dot: BAD, text: BAD },
} as const;

/**
 * One row per case: hollow baseline, filled candidate, the change on the right. At phone width
 * each row stacks its text above a full-width dumbbell.
 */
export function compareSpec(spec: CompareChart, { narrow }: { narrow: boolean }): VegaSpec {
  const rows = compareRows(spec);
  const scale = compareScale(rows.flatMap((row) => [row.from, row.to]));
  const names = `${spec.from} → ${spec.to}`;
  const better = spec.better === "higher" ? "↑ better" : "↓ better";
  const data = rows.map((row) => ({
    ...row,
    ...COMPARE_COLORS[row.state],
    values: `${short(row.from)} → ${formatValue(spec.unit, row.to)}`,
    fromText: formatValue(spec.unit, row.from),
    toText: formatValue(spec.unit, row.to),
    tip: `${row.percent} · ${row.change}`,
  }));
  // Mono 11px advances 6.6px per character.
  const px = (text: string) => text.length * 6.6;
  const deltaW = Math.max(px(better), ...data.map((row) => px(row.change))) + 8;
  const valueW = Math.max(px(names), ...data.map((row) => px(row.values))) + 16;
  const plotEnd = narrow ? "width - 6" : `width - ${deltaW + valueW + 8}`;
  const x = {
    type: "quantitative",
    scale: {
      type: scale.type,
      domain: scale.domain,
      range: [narrow ? 6 : 0, { expr: plotEnd }],
      nice: false,
    },
    axis: {
      orient: "top",
      values: scale.ticks,
      tickCount: scale.ticks.length,
      labelOverlap: "greedy",
      grid: !narrow,
      domain: false,
      ticks: false,
      title: null,
    },
  };
  const y = {
    field: "label",
    type: "nominal",
    sort: null,
    scale: { paddingInner: 0, paddingOuter: 0 },
    title: null,
    ...(narrow ? { axis: null } : {}),
  };
  const offset = narrow ? 8 : 0;
  const header = narrow ? -24 : -8;
  const text = (props: Record<string, unknown>, encoding: Record<string, unknown>): VegaLayer => ({
    mark: { type: "text", baseline: "middle", ...props },
    encoding,
  });
  const colored = (field: string) => ({ field, type: "nominal", scale: null });
  const layer: VegaLayer[] = [];
  if (narrow)
    layer.push({
      data: {
        values: data.flatMap((row) => scale.ticks.map((tick) => ({ label: row.label, tick }))),
      },
      mark: { type: "tick", color: GRID, size: 16, thickness: 1, yOffset: offset },
      encoding: { x: { ...x, field: "tick" }, y },
    });
  layer.push(
    {
      mark: { type: "rule", strokeWidth: 2, yOffset: offset },
      encoding: { x: { ...x, field: "from" }, x2: { field: "to" }, y, color: colored("line") },
    },
    {
      mark: {
        type: "point",
        filled: true,
        fill: "#fff",
        strokeWidth: 1.5,
        size: 40,
        yOffset: offset,
      },
      encoding: { x: { ...x, field: "from" }, y, stroke: colored("line") },
    },
    {
      mark: { type: "point", size: 64, strokeWidth: 0, yOffset: offset },
      encoding: { x: { ...x, field: "to" }, y, color: colored("dot") },
    },
    text(
      { align: "right", x: { expr: "width" }, yOffset: narrow ? -9 : 0 },
      { y, text: { field: "change" }, color: colored("text") },
    ),
  );
  if (narrow)
    layer.push(
      text({ align: "left", x: 0, yOffset: -9, color: INK }, { y, text: { field: "label" } }),
      // Values only when they fit between the label and the change.
      text(
        {
          align: "right",
          x: { expr: `width - ${deltaW + 4}` },
          yOffset: -9,
          color: MUTED,
          text: {
            expr: `width - length(datum.label) * 6.6 - ${deltaW + 24} >= length(datum.values) * 6.6 ? datum.values : ''`,
          },
        },
        { y },
      ),
    );
  else
    layer.push(
      text(
        { align: "left", x: { expr: `${plotEnd} + 16` }, color: MUTED },
        { y, text: { field: "values" } },
      ),
    );
  layer.push(
    {
      data: { values: [{ names, better }] },
      layer: [
        text(
          { align: "left", x: narrow ? 0 : { expr: `${plotEnd} + 16` }, y: header, color: INK },
          { text: { field: "names" } },
        ),
        text(
          { align: "right", x: { expr: "width" }, y: header, color: MUTED },
          { text: { field: "better" } },
        ),
      ],
    },
    // Full-width row strips carry the tooltip and the hover shade.
    {
      mark: { type: "rect", color: INK },
      encoding: {
        x: { value: 0 },
        x2: { value: "width" },
        y,
        opacity: { condition: { param: "row", empty: false, value: 0.04 }, value: 0 },
        tooltip: [
          { field: "label", title: "row" },
          { field: "fromText", title: "from" },
          { field: "toText", title: "to" },
          { field: "tip", title: "change" },
        ],
      },
      params: [{ name: "row", select: { type: "point", on: "pointerover", clear: "pointerout" } }],
    },
  );
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    width: "container",
    height: rows.length * (narrow ? 38 : 20),
    autosize: { type: "fit-x", contains: "padding" },
    padding: { top: narrow ? 26 : 4, right: 4, bottom: 0, left: 0 },
    data: { values: data },
    layer,
  };
}

export function sparklineSpec(spec: ChartSpec): VegaSpec {
  const frame = {
    width: "container",
    height: 16,
    padding: 0,
    autosize: { type: "fit", contains: "padding" },
  };
  if (spec.kind === "histogram") {
    const { series } = histogramBins(spec);
    return {
      ...frame,
      data: { values: (series.at(-1)?.bins ?? []).map((v, k) => ({ k, v })) },
      mark: { type: "bar", color: INK, cornerRadius: 0 },
      encoding: {
        x: { field: "k", type: "ordinal", axis: null, scale: { paddingInner: 0.1 } },
        y: { field: "v", type: "quantitative", axis: null },
      },
    };
  }
  if (spec.kind === "timeline") {
    const { data } = timelineSpec(spec) as { data: { values: unknown[] } };
    return {
      ...frame,
      data,
      mark: { type: "bar", cornerRadius: 0 },
      encoding: {
        x: { field: "a", type: "quantitative", axis: null },
        x2: { field: "b" },
        y: { field: "lane", type: "nominal", sort: null, axis: null, scale: { paddingInner: 0.2 } },
        color: { field: "fill", type: "nominal", scale: null },
      },
    };
  }
  if (spec.kind === "compare") {
    const better = spec.better === "higher" ? 1 : -1;
    return {
      ...frame,
      data: {
        values: compareRows(spec).map((row, k) => ({
          k,
          v: better * Math.log(row.to / row.from),
          c: COMPARE_COLORS[row.state].dot,
        })),
      },
      mark: { type: "bar", cornerRadius: 0 },
      encoding: {
        x: { field: "k", type: "ordinal", axis: null, scale: { paddingInner: 0.25 } },
        y: { field: "v", type: "quantitative", axis: null },
        y2: { datum: 0 },
        color: { field: "c", type: "nominal", scale: null },
      },
    };
  }
  if (spec.kind === "heatmap") {
    const totals = spec.x.map((_, i) => spec.values.reduce((sum, row) => sum + (row[i] ?? 0), 0));
    return {
      ...frame,
      data: { values: totals.map((v, k) => ({ k, v })) },
      mark: { type: "rect", color: INK },
      encoding: {
        x: { field: "k", type: "ordinal", axis: null, scale: { paddingInner: 0.1 } },
        opacity: {
          field: "v",
          type: "quantitative",
          scale: { type: "sqrt", range: [0.06, 1] },
          legend: null,
        },
      },
    };
  }
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
  if (spec.kind === "heatmap")
    return [{ label: String(value["cell"]), value: String(value["value"]) }];
  if (spec.kind === "compare")
    return [
      { label: String(value["row"]), value: "" },
      { label: spec.from, value: String(value["from"]) },
      { label: spec.to, value: String(value["to"]) },
      { label: "change", value: String(value["change"]) },
    ];
  if (spec.kind === "timeline" || spec.kind === "histogram")
    return Object.entries(value)
      .filter(([, item]) => item !== "")
      .map(([label, item]) => ({ label, value: String(item) }));
  const { colors, dash } = seriesStyles(spec.series.length);
  const many = spec.series.length > 1;
  return [
    { label: "time", value: String(value["time"]) },
    ...spec.series
      .map((series, index) => ({ series, index, v: number(value[series.name]) }))
      .filter((entry) => Number.isFinite(entry.v))
      .sort((a, b) => b.v - a.v)
      .map(({ series, index, v }) => ({
        label: series.name,
        value: formatValue(spec.unit, v),
        ...(many ? { color: colors[index] ?? INK, dash: dash[index] ?? [] } : {}),
      })),
    ...spec.series.flatMap(({ band }) => {
      const [lo, hi] = (["lo", "hi"] as const).map((end) =>
        band === undefined ? undefined : value[bandTitle(band.name, end)],
      );
      return band === undefined || lo === undefined || hi === undefined
        ? []
        : [
            {
              label: band.name,
              value: `${short(number(lo))}–${formatValue(spec.unit, number(hi))}`,
            },
          ];
    }),
  ];
}

/** The folded row carries the latest value only when one line names it unambiguously. */
export function latestValue(spec: ChartSpec): string | null {
  if (spec.kind === "compare") {
    const worse = compareRows(spec).filter((row) => row.state === "worse").length;
    return worse === 0 ? null : `${worse} worse`;
  }
  if (spec.kind === "timeline")
    return formatDuration(
      Math.max(...spec.spans.map((span) => span.end)) -
        Math.min(...spec.spans.map((span) => span.start)),
    );
  if (spec.kind !== "line" || spec.series.length !== 1) return null;
  const end = spec.series[0]?.points.at(-1);
  return end === undefined ? null : formatValue(spec.unit, end[1]);
}
