import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;
const ms = Type.Integer({ minimum: 0 });
const count = Type.Integer({ minimum: 0 });

/** One Pi turn's waterfall (docs/web-ui.md "Pi transcript timeline"); `turnId` is the turn's user record. */
export function turnTimelinePath(orbId: string, turnId: string): string {
  return `/api/v1/orbs/${encodeURIComponent(orbId)}/turns/${encodeURIComponent(turnId)}/timeline`;
}

/**
 * A model call. Root calls come from the assistant history record, joined to `model_calls` by
 * `response_id` for `ttftMs`/`thinkingMs`; other uses are `model_calls` rows placed by their start.
 * Phase offsets are from `start`; both are absent before 2026-10-24 and for unstreamed calls.
 */
export const TimelineModelRowSchema = Type.Object(
  {
    kind: Type.Literal("model"),
    id: Type.String(),
    start: ms,
    end: ms,
    /** `model_calls.use`: root, subagent, compaction, turn_summary, headline, orb_name. */
    use: Type.String(),
    model: Type.String(),
    /** Subagent calls: the label of the subagent whose session made the call. */
    subject: Type.Optional(Type.String()),
    ttftMs: Type.Optional(ms),
    thinkingMs: Type.Optional(ms),
    input: Type.Optional(count),
    output: Type.Optional(count),
    cacheRead: Type.Optional(count),
    cacheWrite: Type.Optional(count),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    /** Pi stop reason (`stop`, `toolUse`, `length`, `error`, `aborted`). */
    stop: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    /** The assistant's text, bounded. */
    said: Type.Optional(Type.String()),
  },
  closed,
);

/** A tool call; `nested` rows are code-mode calls placed at their persisted `startedAt`. */
export const TimelineToolRowSchema = Type.Object(
  {
    kind: Type.Literal("tool"),
    id: Type.String(),
    start: ms,
    end: ms,
    name: Type.String(),
    arg: Type.Optional(Type.String()),
    nested: Type.Boolean(),
    status: Type.Union([
      Type.Literal("ok"),
      Type.Literal("error"),
      Type.Literal("cancelled"),
      Type.Literal("unfinished"),
    ]),
    /** First line of the result, bounded. */
    result: Type.Optional(Type.String()),
    /** Code-mode nested calls the script made, with or without a start time. */
    calls: Type.Optional(count),
  },
  closed,
);

/** An instant in the turn. `compaction` marks a compaction record without a matching model call. */
export const TimelineMarkerRowSchema = Type.Object(
  {
    kind: Type.Literal("marker"),
    id: Type.String(),
    start: ms,
    marker: Type.Union([
      Type.Literal("steering"),
      Type.Literal("message"),
      Type.Literal("notification"),
      Type.Literal("alert"),
      Type.Literal("restart"),
      Type.Literal("wake"),
      Type.Literal("compaction"),
    ]),
    text: Type.Optional(Type.String()),
  },
  closed,
);

export const TimelineRowSchema = Type.Union([
  TimelineModelRowSchema,
  TimelineToolRowSchema,
  TimelineMarkerRowSchema,
]);
export type TimelineRow = Static<typeof TimelineRowSchema>;

/** Rows in display order: by start, nested code-mode calls directly after their parent. */
export const TurnTimelineSchema = Type.Object(
  { start: ms, rows: Type.Array(TimelineRowSchema) },
  closed,
);
export type TurnTimeline = Static<typeof TurnTimelineSchema>;

/** The fields of a history or display record that decide Pi turn boundaries. */
export interface TurnBoundaryRecord {
  readonly id: string;
  readonly type: string;
  readonly role?: string;
  readonly finishReason?: string;
  readonly inboxMessageIds?: readonly string[];
}

/** A human message band: a user record with an inbox receipt (docs/web-ui.md). */
export function isUserBand(record: TurnBoundaryRecord): boolean {
  return (
    record.type === "message" && record.role === "user" && record.inboxMessageIds !== undefined
  );
}

/**
 * IDs of the user bands that start a Pi turn: those delivered while the agent was idle, i.e. with no
 * earlier message record or with an assistant record not asking for tools as the latest one.
 * Bands delivered mid-run are steering and belong to the running turn.
 */
export function piTurnStarts(records: readonly TurnBoundaryRecord[]): ReadonlySet<string> {
  const starts = new Set<string>();
  let idle = true;
  for (const record of records) {
    if (record.type !== "message") continue;
    if (idle && isUserBand(record)) starts.add(record.id);
    idle = record.role === "assistant" && record.finishReason !== "toolUse";
  }
  return starts;
}
