import { type Static, Type } from "typebox";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";

const closed = { additionalProperties: false } as const;

export const RuntimeHealthSchema = Type.Union([
  Type.Object(
    {
      v: Type.Literal(1),
      orbId: Type.String(),
      runtimeInstanceId: Type.String(),
      status: Type.Literal("initializing"),
      phase: Type.Union([
        Type.Literal("booting"),
        Type.Literal("cloning"),
        Type.Literal("loading_session"),
        Type.Literal("checking_auth"),
      ]),
    },
    closed,
  ),
  Type.Object(
    {
      v: Type.Literal(1),
      orbId: Type.String(),
      runtimeInstanceId: Type.String(),
      status: Type.Literal("ready"),
      sessionId: Type.String(),
      checkoutCommit: Type.String(),
      activity: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
      operationId: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object(
    {
      v: Type.Literal(1),
      orbId: Type.String(),
      runtimeInstanceId: Type.String(),
      status: Type.Literal("failed"),
      error: Type.Object(
        {
          code: Type.String(),
          message: Type.String(),
          retryable: Type.Boolean(),
        },
        closed,
      ),
    },
    closed,
  ),
]);
export type RuntimeHealth = Static<typeof RuntimeHealthSchema>;

export const HISTORY_PULL_DEFAULT_LIMIT = 100;
export const HISTORY_PULL_MIN_LIMIT = 1;
export const HISTORY_PULL_MAX_LIMIT = 500;

export const PullHistoryResponseSchema = Type.Object(
  {
    v: Type.Literal(1),
    orbId: Type.String(),
    runtimeInstanceId: Type.String(),
    activity: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
    session: HarnessSessionMetadataSchema,
    records: Type.Array(HistoryRecordSchema),
    /** Equal to `after` when records is empty; otherwise the final record ID. */
    cursor: Type.Union([Type.String(), Type.Null()]),
    /** Active head represented after applying exactly this returned prefix. */
    headId: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type PullHistoryResponse = Static<typeof PullHistoryResponseSchema>;

export const RuntimeHttpErrorSchema = Type.Object(
  {
    v: Type.Literal(1),
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("invalid_request"),
          Type.Literal("cursor_not_found"),
          Type.Literal("history_unavailable"),
        ]),
        message: Type.String(),
        retryable: Type.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
export type RuntimeHttpError = Static<typeof RuntimeHttpErrorSchema>;
