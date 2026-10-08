import { type Static, Type } from "typebox";

const nullableTime = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const count = Type.Integer({ minimum: 0 });
export const RuntimeStreamStatsSchema = Type.Object(
  {
    requestId: Type.String(),
    operationId: Type.Union([Type.String(), Type.Null()]),
    sessionId: Type.String(),
    parentSessionId: Type.Optional(Type.String()),
    attempt: count,
    startedAt: Type.Number({ minimum: 0 }),
    firstEventAt: nullableTime,
    lastEventAt: nullableTime,
    lastEventType: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]),
    events: count,
    normalizedEvents: count,
    normalizedToolArgumentEvents: count,
    toolArgumentEvents: count,
    lastNormalizedAt: nullableTime,
    textBytes: count,
    reasoningBytes: count,
    toolArgumentBytes: count,
    phase: Type.Union([
      Type.Literal("waiting"),
      Type.Literal("streaming"),
      Type.Literal("text"),
      Type.Literal("reasoning"),
      Type.Literal("tool_arguments"),
      Type.Literal("terminal"),
    ]),
    transport: Type.Union([Type.Literal("unknown"), Type.Literal("sse")]),
    httpResponses: count,
    httpStatus: Type.Union([count, Type.Null()]),
    issues: Type.Array(
      Type.Union([Type.Literal("no_event_gap"), Type.Literal("large_tool_arguments")]),
      { maxItems: 2 },
    ),
  },
  { additionalProperties: false },
);
export type RuntimeStreamStats = Static<typeof RuntimeStreamStatsSchema>;
