import { type Static, Type } from "typebox";
import { MessageInputBlockSchema } from "./frames.ts";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";

const closed = { additionalProperties: false } as const;

/**
 * The boot-time interrupted-turn decision, reported only when it is notable
 * (docs/lifecycle.md): a resume performed, a resume the loop guard suppressed,
 * or a resume whose marker never reached the harness. Ordinary boots — a
 * settled tail, a fresh session — report nothing at all: edges, not levels.
 */
export const RuntimeTurnResumeSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("resumed"),
      Type.Literal("declined_already_resumed"),
      Type.Literal("resume_failed"),
    ]),
    /** The interrupted tail shape the runtime detected. */
    shape: Type.Optional(
      Type.Union([
        Type.Literal("trailing_tool_result"),
        Type.Literal("dangling_tool_calls"),
        Type.Literal("unanswered_user_message"),
      ]),
    ),
    /** Record ID of the dangling tail entry the decision keyed off. */
    headRecordId: Type.Optional(Type.String()),
  },
  closed,
);
export type RuntimeTurnResume = Static<typeof RuntimeTurnResumeSchema>;

/**
 * The outcome of one boot hook run (`docs/orb-setup-hook.md`). Deliberately
 * carries no output: the log path points at the text, and the control plane
 * must never log or store what a repository's script printed.
 */
export const RuntimeHookStatusSchema = Type.Object(
  {
    hook: Type.Union([Type.Literal("setup"), Type.Literal("resume")]),
    outcome: Type.Union([
      Type.Literal("ok"),
      Type.Literal("failed"),
      Type.Literal("timeout"),
      Type.Literal("hook_not_executable"),
    ]),
    /** Null when the hook was killed, never spawned, or never executable. */
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    incarnation: Type.String(),
    startedAt: Type.String(),
    endedAt: Type.String(),
    logPath: Type.String(),
  },
  closed,
);
export type RuntimeHookStatus = Static<typeof RuntimeHookStatusSchema>;

/** Latest outcome per hook; absent members mean the hook has not run here. */
export const RuntimeHooksSchema = Type.Object(
  {
    setup: Type.Optional(RuntimeHookStatusSchema),
    resume: Type.Optional(RuntimeHookStatusSchema),
  },
  closed,
);
export type RuntimeHooks = Static<typeof RuntimeHooksSchema>;

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
        // `.agents/setup` is holding readiness. The control plane holds its
        // ordinary boot deadline while this phase is reported, so a hook that
        // takes twenty minutes is not a boot failure.
        Type.Literal("setup_running"),
        Type.Literal("loading_session"),
        Type.Literal("checking_auth"),
      ]),
      hooks: Type.Optional(RuntimeHooksSchema),
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
      turnResume: Type.Optional(RuntimeTurnResumeSchema),
      hooks: Type.Optional(RuntimeHooksSchema),
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

export const DeliverOrbMessageRequestSchema = Type.Object(
  {
    v: Type.Literal(1),
    messageId: Type.String(),
    messageIds: Type.Array(Type.String(), { minItems: 1 }),
    content: Type.Array(MessageInputBlockSchema, { minItems: 1 }),
  },
  closed,
);
export type DeliverOrbMessageRequest = Static<typeof DeliverOrbMessageRequestSchema>;

export const DeliverOrbMessageResponseSchema = Type.Object(
  {
    v: Type.Literal(1),
    messageId: Type.String(),
    status: Type.Union([Type.Literal("queued"), Type.Literal("persisted")]),
    delivery: Type.Union([Type.Literal("turn"), Type.Literal("steer")]),
    operationId: Type.String(),
    duplicate: Type.Boolean(),
  },
  closed,
);
export type DeliverOrbMessageResponse = Static<typeof DeliverOrbMessageResponseSchema>;

export const RuntimeHttpErrorSchema = Type.Object(
  {
    v: Type.Literal(1),
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("invalid_request"),
          Type.Literal("cursor_not_found"),
          Type.Literal("history_unavailable"),
          Type.Literal("message_unavailable"),
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
