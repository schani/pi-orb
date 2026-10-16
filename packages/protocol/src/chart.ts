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
          { name: label, points: Type.Array(Type.Tuple([time, point]), { minItems: 1 }) },
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

/** Stored form: epoch-millisecond timestamps, finite values only. */
export const ChartSpecSchema = Type.Union([line(Type.Number(), value), bar]);
export type ChartSpec = Static<typeof ChartSpecSchema>;
export type LineChart = Extract<ChartSpec, { kind: "line" }>;
export type BarChart = Extract<ChartSpec, { kind: "bar" }>;

/** What a script may pass to chart(): epoch-ms or Date.parse-able timestamps, null points (dropped). */
const LineInputSchema = line(
  Type.Union([Type.Number(), Type.String()]),
  Type.Union([value, Type.Null()]),
);

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
  if (kind !== "line" && kind !== "bar")
    return invalid('expected {kind: "line", title, series} or {kind: "bar", title, bars}');
  const schema = kind === "line" ? LineInputSchema : bar;
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
  let total = 0;
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
    if (series.some((existing) => existing.name === item.name))
      return invalid(`series "${item.name}" appears twice`);
    total += points.length;
    series.push({ name: item.name, points });
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
