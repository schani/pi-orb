import { err, ok, Result } from "neverthrow";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const USAGE_PATH = "/api/v1/usage";
/** Named `model_calls.use` values; Claude auxiliary calls store their raw `query_source` (docs/model-usage.md). */
export type ModelCallUse =
  | "root"
  | "subagent"
  | "compaction"
  | "turn_summary"
  | "headline"
  | "orb_name";

/** Hidden history event carrying one Claude Code model call (docs/model-usage.md). */
export const CLAUDE_MODEL_CALL_EVENT = "claude.model_call";
// `model_calls` columns are `integer`; an out-of-range value must not fail the history commit.
const int = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
/** One Claude Code `api_request` (`ok`) or `api_error` (`error`, zero tokens) OpenTelemetry event. */
export const ClaudeModelCallSchema = Type.Object({
  at: Type.String(),
  model: Type.String(),
  /** `sdk` (root), `agent:*` (subagent), `compact`, or an auxiliary source such as `generate_session_title`. */
  querySource: Type.Optional(Type.String()),
  outcome: Type.Union([Type.Literal("ok"), Type.Literal("error")]),
  input: int,
  output: int,
  cacheRead: int,
  cacheWrite: int,
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  durationMs: Type.Optional(int),
});
export type ClaudeModelCall = Static<typeof ClaudeModelCallSchema>;
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
          orbId: Type.String(),
          use: Type.String(),
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
