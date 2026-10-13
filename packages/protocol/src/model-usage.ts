import { err, ok, Result } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const USAGE_PATH = "/api/v1/usage";
export const ModelCallUseSchema = Type.Union([
  Type.Literal("root"),
  Type.Literal("subagent"),
  Type.Literal("compaction"),
  Type.Literal("turn_summary"),
  Type.Literal("headline"),
  Type.Literal("orb_name"),
]);
export type ModelCallUse = Static<typeof ModelCallUseSchema>;
const closed = { additionalProperties: false } as const;
const timestamp = Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boundaries = Type.Array(timestamp, { minItems: 2, maxItems: 188 });
export const UsageTotalsSchema = Type.Object(
  {
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    calls: count,
  },
  closed,
);
export type UsageTotals = Static<typeof UsageTotalsSchema>;
export const UsageViewSchema = Type.Object(
  {
    boundaries,
    summary: UsageTotalsSchema,
    buckets: Type.Array(
      Type.Object(
        {
          ...UsageTotalsSchema.properties,
          at: timestamp,
          use: ModelCallUseSchema,
          provider: Type.String(),
          model: Type.String(),
        },
        closed,
      ),
    ),
    orbs: Type.Array(
      Type.Object(
        {
          ...UsageTotalsSchema.properties,
          id: Type.String(),
          name: Type.Union([Type.String(), Type.Null()]),
        },
        closed,
      ),
    ),
  },
  closed,
);
export type UsageView = Static<typeof UsageViewSchema>;
export interface UsageRequestError {
  readonly type: "usage_request_invalid";
  readonly message: string;
}
const invalid = (): UsageRequestError => ({
  type: "usage_request_invalid",
  message: "Expected 2–188 increasing bucket edges, at most 25 hours apart and 187 days total",
});
const QuerySchema = Type.Object({ boundaries: Type.String({ maxLength: 4096 }) }, closed);

/** Client-computed civil-time edges keep timezone/DST arithmetic out of the server. */
export function parseUsageQuery(query: unknown) {
  if (!Check(QuerySchema, query)) return err<number[], UsageRequestError>(invalid());
  const parsed = Result.fromThrowable((): unknown => JSON.parse(query.boundaries), invalid)();
  if (parsed.isErr()) return err<number[], UsageRequestError>(parsed.error);
  const edges = parsed.value;
  if (!Check(boundaries, edges)) return err<number[], UsageRequestError>(invalid());
  const span = (edges.at(-1) ?? 0) - (edges[0] ?? 0);
  if (
    span > 187 * 86_400_000 ||
    edges.some(
      (at, i) => i > 0 && (at <= (edges[i - 1] ?? 0) || at - (edges[i - 1] ?? 0) > 25 * 3_600_000),
    )
  )
    return err<number[], UsageRequestError>(invalid());
  return ok<number[], UsageRequestError>(edges);
}
