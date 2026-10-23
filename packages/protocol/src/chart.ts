import { err, ok, type Result } from "neverthrow";
import { type Static, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";

/** Content type of a chart leaf inside a history `tool_result` (docs/web-ui.md, transcript charts). */
export const CHART_CONTENT_TYPE = "application/vnd.pi-orb.chart+json";
export const CHART_MAX_SERIES = 6;
export const CHART_MAX_POINTS = 5_000;
export const CHART_MAX_BARS = 40;
export const CHART_MAX_PER_SCRIPT = 8;
export const CHART_MAX_SOURCE_CHARS = 2_048;
export const CHART_MAX_HISTOGRAM_SERIES = 2;
export const CHART_MAX_SPANS = 200;
export const CHART_MAX_HEATMAP_COLUMNS = 60;

const closed = { additionalProperties: false } as const;
const title = Type.String({ minLength: 1, maxLength: 120 });
const label = Type.String({ minLength: 1, maxLength: 80 });
const value = Type.Number();
const common = {
  title,
  unit: Type.Optional(Type.String({ maxLength: 12 })),
  source: Type.Optional(Type.String({ maxLength: CHART_MAX_SOURCE_CHARS })),
};
const line = <Time extends TSchema, Point extends TSchema>(time: Time, point: Point) =>
  Type.Object(
    {
      kind: Type.Literal("line"),
      ...common,
      series: Type.Array(
        Type.Object(
          {
            name: label,
            points: Type.Array(Type.Tuple([time, point]), { minItems: 1 }),
            /** A low–high range drawn behind the line, e.g. p5–p95. */
            band: Type.Optional(
              Type.Object(
                {
                  name: label,
                  points: Type.Array(Type.Tuple([time, point, point]), { minItems: 1 }),
                },
                closed,
              ),
            ),
          },
          closed,
        ),
        { minItems: 1 },
      ),
      markers: Type.Optional(Type.Array(Type.Object({ at: time, label }, closed), { maxItems: 8 })),
      thresholds: Type.Optional(Type.Array(Type.Object({ value, label }, closed), { maxItems: 4 })),
    },
    closed,
  );
const bar = Type.Object(
  {
    kind: Type.Literal("bar"),
    ...common,
    bars: Type.Array(Type.Object({ label, value }, closed), {
      minItems: 1,
      maxItems: CHART_MAX_BARS,
    }),
  },
  closed,
);

const histogram = Type.Object(
  {
    kind: Type.Literal("histogram"),
    ...common,
    series: Type.Array(
      Type.Object({ name: label, values: Type.Array(value, { minItems: 1 }) }, closed),
      { minItems: 1, maxItems: CHART_MAX_HISTOGRAM_SERIES },
    ),
  },
  closed,
);
const timeline = <Time extends TSchema>(time: Time) =>
  Type.Object(
    {
      kind: Type.Literal("timeline"),
      title,
      source: common.source,
      spans: Type.Array(
        Type.Object(
          {
            lane: label,
            label,
            start: time,
            end: time,
            state: Type.Optional(Type.Union([Type.Literal("failed"), Type.Literal("queued")])),
            critical: Type.Optional(Type.Boolean()),
          },
          closed,
        ),
        { minItems: 1, maxItems: CHART_MAX_SPANS },
      ),
    },
    closed,
  );
const heatmap = Type.Object(
  {
    kind: Type.Literal("heatmap"),
    ...common,
    x: Type.Array(label, { minItems: 1, maxItems: CHART_MAX_HEATMAP_COLUMNS }),
    y: Type.Array(label, { minItems: 1, maxItems: CHART_MAX_BARS }),
    /** One row per `y` label, one value per `x` label. */
    values: Type.Array(Type.Array(value)),
  },
  closed,
);

const compare = Type.Object(
  {
    kind: Type.Literal("compare"),
    ...common,
    /** Names of the baseline and the candidate, e.g. "main" and "feat/x". */
    from: label,
    to: label,
    better: Type.Union([Type.Literal("lower"), Type.Literal("higher")]),
    /** Percent of the baseline within which a row counts as unchanged; default 5. */
    tolerance: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    rows: Type.Array(Type.Object({ label, from: value, to: value }, closed), {
      minItems: 1,
      maxItems: CHART_MAX_BARS,
    }),
  },
  closed,
);

/** Stored form: epoch-millisecond timestamps, finite values only. */
export const ChartSpecSchema = Type.Union([
  line(Type.Number(), value),
  bar,
  histogram,
  timeline(Type.Number()),
  heatmap,
  compare,
]);
export type ChartSpec = Static<typeof ChartSpecSchema>;
export type LineChart = Extract<ChartSpec, { kind: "line" }>;
export type BarChart = Extract<ChartSpec, { kind: "bar" }>;
export type HistogramChart = Extract<ChartSpec, { kind: "histogram" }>;
export type TimelineChart = Extract<ChartSpec, { kind: "timeline" }>;
export type HeatmapChart = Extract<ChartSpec, { kind: "heatmap" }>;
export type CompareChart = Extract<ChartSpec, { kind: "compare" }>;

/** What a script may pass to chart(): epoch-ms or Date.parse-able timestamps, null points (dropped). */
const inputTime = Type.Union([Type.Number(), Type.String()]);
const InputSchemas = {
  line: line(inputTime, Type.Union([value, Type.Null()])),
  bar,
  histogram,
  timeline: timeline(inputTime),
  heatmap,
  compare,
};

export interface ChartSpecError {
  readonly type: "chart_invalid";
  readonly message: string;
}

const invalid = (message: string) =>
  err<ChartSpec, ChartSpecError>({ type: "chart_invalid", message: `chart(): ${message}` });

function timestamp(raw: number | string): number | undefined {
  const parsed = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Validates and normalizes a script's chart() argument into the stored form. */
export function parseChartSpec(input: unknown): Result<ChartSpec, ChartSpecError> {
  if (
    typeof input === "object" &&
    input !== null &&
    "kind" in input &&
    input.kind === "line" &&
    "series" in input &&
    Array.isArray(input.series) &&
    input.series.length > CHART_MAX_SERIES
  )
    return invalid(
      `at most ${CHART_MAX_SERIES} series per chart; fold the rest into "other" or split into several charts`,
    );
  const kind = typeof input === "object" && input !== null && "kind" in input ? input.kind : null;
  if (typeof kind !== "string" || !Object.hasOwn(InputSchemas, kind))
    return invalid('expected kind "line", "bar", "histogram", "timeline", "heatmap" or "compare"');
  const schema = InputSchemas[kind as keyof typeof InputSchemas];
  if (!Check(schema, input)) {
    const first = [...Errors(schema, input)][0];
    const params = (first?.params ?? {}) as {
      requiredProperties?: string[];
      additionalProperties?: string[];
    };
    return invalid(
      first?.keyword === "required"
        ? `missing ${params.requiredProperties?.join(", ")}`
        : first?.keyword === "additionalProperties" || first?.keyword === "boolean"
          ? `unknown field ${params.additionalProperties?.join(", ") ?? first.instancePath}`
          : `${first?.instancePath || "spec"} ${first?.message ?? "is invalid"}`,
    );
  }
  if (input.source !== undefined && !/^https?:\/\/[^\s]+$/i.test(input.source))
    return invalid("source must be an http(s) URL");
  if (input.kind === "bar") {
    if (!input.bars.every((item) => Number.isFinite(item.value)))
      return invalid("bars need finite values");
    return ok(input);
  }
  if (input.kind === "histogram") {
    if (new Set(input.series.map((item) => item.name)).size !== input.series.length)
      return invalid("histogram series names must be unique");
    if (input.series.reduce((sum, item) => sum + item.values.length, 0) > CHART_MAX_POINTS)
      return invalid(`at most ${CHART_MAX_POINTS} points per chart; sample first`);
    return ok(input);
  }
  if (input.kind === "heatmap") {
    if (
      input.values.length !== input.y.length ||
      !input.values.every((row) => row.length === input.x.length)
    )
      return invalid(`values must be ${input.y.length} rows of ${input.x.length} values`);
    if (!input.values.every((row) => row.every((cell) => cell >= 0)))
      return invalid("heatmap values must be non-negative");
    return ok(input);
  }
  if (input.kind === "compare") {
    if (input.from === input.to) return invalid("from and to must name different things");
    if (!input.rows.every((row) => row.from > 0 && row.to > 0))
      return invalid("compare values must be positive; changes are ratios");
    const labels = new Set<string>();
    for (const row of input.rows) {
      if (labels.has(row.label)) return invalid(`row "${row.label}" appears twice`);
      labels.add(row.label);
    }
    return ok(input);
  }
  if (input.kind === "timeline") {
    const spans: TimelineChart["spans"] = [];
    for (const span of input.spans) {
      const start = timestamp(span.start);
      const end = timestamp(span.end);
      if (start === undefined || end === undefined)
        return invalid(`span "${span.label}" has an unparseable timestamp`);
      if (end < start) return invalid(`span "${span.label}" ends before it starts`);
      spans.push({ ...span, start, end });
    }
    return ok({ ...input, spans });
  }
  let total = 0;
  const names = new Set<string>();
  const series: LineChart["series"] = [];
  for (const item of input.series) {
    const points: [number, number][] = [];
    for (const [rawTime, rawValue] of item.points) {
      const at = timestamp(rawTime);
      if (at === undefined) return invalid(`series "${item.name}" has an unparseable timestamp`);
      if (rawValue === null) continue;
      if (!Number.isFinite(rawValue))
        return invalid(`series "${item.name}" has a non-finite value`);
      points.push([at, rawValue]);
    }
    if (points.length === 0) return invalid(`series "${item.name}" has no points`);
    // Band names share the tooltip with series names.
    for (const name of [item.name, ...(item.band === undefined ? [] : [item.band.name])]) {
      if (names.has(name)) return invalid(`series "${name}" appears twice`);
      names.add(name);
    }
    total += points.length;
    if (item.band === undefined) {
      series.push({ name: item.name, points });
      continue;
    }
    const band: [number, number, number][] = [];
    for (const [rawTime, low, high] of item.band.points) {
      const at = timestamp(rawTime);
      if (at === undefined) return invalid(`band "${item.band.name}" has an unparseable timestamp`);
      if (low === null || high === null) continue;
      if (!Number.isFinite(low) || !Number.isFinite(high))
        return invalid(`band "${item.band.name}" has a non-finite value`);
      if (low > high) return invalid(`band "${item.band.name}" has a low above its high`);
      band.push([at, low, high]);
    }
    if (band.length === 0) return invalid(`band "${item.band.name}" has no points`);
    total += band.length;
    series.push({ name: item.name, points, band: { name: item.band.name, points: band } });
  }
  if (total > CHART_MAX_POINTS)
    return invalid(`at most ${CHART_MAX_POINTS} points per chart; downsample first`);
  const markers: LineChart["markers"] = [];
  for (const marker of input.markers ?? []) {
    const at = timestamp(marker.at);
    if (at === undefined) return invalid(`marker "${marker.label}" has an unparseable timestamp`);
    markers.push({ at, label: marker.label });
  }
  if (!(input.thresholds ?? []).every((item) => Number.isFinite(item.value)))
    return invalid("thresholds need finite values");
  return ok({
    kind: "line",
    title: input.title,
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    ...(input.source === undefined ? {} : { source: input.source }),
    series,
    ...(input.markers === undefined ? {} : { markers }),
    ...(input.thresholds === undefined ? {} : { thresholds: input.thresholds }),
  });
}
