import { type Static, type TSchema, Type } from "typebox";
import { MessageInputBlockSchema } from "./frames.ts";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";
import { ORB_NAME_MAX_CHARS } from "./orb-naming.ts";
import { MintFailureCodeSchema } from "./workload-identity.ts";

const closed = { additionalProperties: false } as const;

export const OrbStateSchema = Type.Union([
  Type.Literal("creating"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("stopped"),
  Type.Literal("failed"),
  Type.Literal("deleting"),
  Type.Literal("archiving"),
  Type.Literal("archived"),
]);
export type OrbState = Static<typeof OrbStateSchema>;

/** Why an orb last entered `stopping`; absent for explicit stops (docs/lifecycle.md). */
export const StopReasonSchema = Type.Literal("idle");
export type StopReason = Static<typeof StopReasonSchema>;

export const PROJECT_NAME_MAX_CHARS = 80;
export const CreateProjectRequestSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_CHARS }),
    repositoryUrl: Type.String(),
  },
  closed,
);
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: PROJECT_NAME_MAX_CHARS }) },
  closed,
);
export type UpdateProjectRequest = Static<typeof UpdateProjectRequestSchema>;

export const CreateOrbRequestSchema = Type.Object(
  {
    // Orb IDs become provider resource names (`pi-orb-<id>-i<n>`), MagicDNS
    // labels, and Tailscale key descriptions (`pi-orb <id> i<n>`), so they are
    // restricted to a DNS-safe alphabet with no spaces: an unconstrained ID
    // could make one orb's exact-match cleanup reach another's resources.
    id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,63}$" }),
    name: Type.Optional(Type.String({ maxLength: ORB_NAME_MAX_CHARS })),
  },
  closed,
);
export type CreateOrbRequest = Static<typeof CreateOrbRequestSchema>;

export const UpdateOrbRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: ORB_NAME_MAX_CHARS }) },
  closed,
);
export type UpdateOrbRequest = Static<typeof UpdateOrbRequestSchema>;

export const ProjectStateSchema = Type.Union([Type.Literal("active"), Type.Literal("deleting")]);
export type ProjectState = Static<typeof ProjectStateSchema>;

export const ProjectDeletionProgressSchema = Type.Object(
  {
    total: Type.Number(),
    remaining: Type.Number(),
    blocked: Type.Number(),
  },
  closed,
);
export type ProjectDeletionProgress = Static<typeof ProjectDeletionProgressSchema>;

export const ProjectViewSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    repositoryUrl: Type.String(),
    state: ProjectStateSchema,
    deletionProgress: Type.Optional(ProjectDeletionProgressSchema),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  closed,
);
export type ProjectView = Static<typeof ProjectViewSchema>;

export const OrbStateDetailSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("discarding_failed_compute"),
      retrying: Type.Boolean(),
      message: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("replacing_stale_compute"),
      retrying: Type.Boolean(),
      message: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("draining_history"),
      retrying: Type.Boolean(),
      message: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("deleting_resources"),
      retrying: Type.Boolean(),
      message: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("archiving_orb"),
      phase: Type.Union([
        Type.Literal("waiting_for_idle"),
        Type.Literal("sealing_history"),
        Type.Literal("deleting_resources"),
      ]),
      retrying: Type.Boolean(),
      message: Type.Optional(Type.String()),
    },
    closed,
  ),
  Type.Object(
    {
      type: Type.Literal("waiting_for_runtime"),
      hostState: Type.Union([Type.String(), Type.Null()]),
      secondsSinceHostRunning: Type.Union([Type.Number(), Type.Null()]),
      probeAttempts: Type.Number(),
      lastProbeError: Type.Optional(Type.String()),
    },
    closed,
  ),
  /** The repository's `.agents/setup` is holding the boot (docs/orb-setup-hook.md). */
  Type.Object(
    {
      type: Type.Literal("running_setup"),
      secondsRunning: Type.Number(),
    },
    closed,
  ),
  /**
   * The current boot's setup or resume hook did not succeed, as the running
   * orb's own health report states it. The orb runs anyway; this says so and
   * points at the log inside the orb. Never carries the hook's output.
   */
  Type.Object(
    {
      type: Type.Literal("setup_failed"),
      hook: Type.Union([Type.Literal("setup"), Type.Literal("resume")]),
      reason: Type.Union([
        Type.Literal("failed"),
        Type.Literal("timeout"),
        Type.Literal("hook_not_executable"),
      ]),
      logPath: Type.String(),
    },
    closed,
  ),
]);
export type OrbStateDetail = Static<typeof OrbStateDetailSchema>;

export const OrbActionRequiredSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal("openai_codex_device_login"),
      Type.Literal("github_device_login"),
    ]),
    verificationUri: Type.String(),
    userCode: Type.String(),
    expiresAt: Type.String(),
  },
  closed,
);
export type OrbActionRequired = Static<typeof OrbActionRequiredSchema>;

/**
 * The orb's workload-identity status (docs/workload-identity.md). Present only
 * while the latest mint outcome is a failure: a later successful mint
 * supersedes it, which is why the view carries no "healthy" variant. It is
 * durable status read straight off the orb row, never a token, an audience, or
 * anything else the mint saw.
 */
export const OrbIdentityStatusSchema = Type.Object(
  { failureCode: MintFailureCodeSchema, failureAt: Type.String() },
  closed,
);
export type OrbIdentityStatus = Static<typeof OrbIdentityStatusSchema>;

export const OrbViewSchema = Type.Object(
  {
    id: Type.String(),
    projectId: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    state: OrbStateSchema,
    stateVersion: Type.Number(),
    /** Latest activity observed by the control plane; present only when known for a running orb. */
    activity: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("busy")])),
    checkoutCommit: Type.Optional(Type.String()),
    lastError: Type.Optional(Type.String()),
    /** Synthesized from in-memory reconciler state; never stored. */
    stateDetail: Type.Optional(OrbStateDetailSchema),
    /** Present when the last stop was automatic ("stopped (idle)", docs/lifecycle.md). */
    stopReason: Type.Optional(StopReasonSchema),
    stateChangedAt: Type.String(),
    archivedAt: Type.Optional(Type.String()),
    /**
     * MagicDNS host every port inside the orb is reachable at (docs/ports.md).
     * Derived from the orb id and the configured tailnet, never stored;
     * absent when tailscale port exposure is not configured.
     */
    previewHost: Type.Optional(Type.String()),
    /** Synthesized from the in-memory device flow; never stored. */
    actionRequired: Type.Optional(OrbActionRequiredSchema),
    /** Durable mint failure, present only while it is the latest outcome. */
    identity: Type.Optional(OrbIdentityStatusSchema),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  closed,
);
export type OrbView = Static<typeof OrbViewSchema>;

export const OrbHistoryViewSchema = Type.Object(
  {
    orbId: Type.String(),
    session: Type.Union([HarnessSessionMetadataSchema, Type.Null()]),
    cursor: Type.Union([Type.String(), Type.Null()]),
    headId: Type.Union([Type.String(), Type.Null()]),
    records: Type.Array(HistoryRecordSchema),
  },
  closed,
);
export type OrbHistoryView = Static<typeof OrbHistoryViewSchema>;

export const EnqueueOrbMessageRequestSchema = Type.Object(
  { content: Type.Array(MessageInputBlockSchema, { minItems: 1 }) },
  closed,
);
export type EnqueueOrbMessageRequest = Static<typeof EnqueueOrbMessageRequestSchema>;

export const OrbMessageStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("delivering"),
  Type.Literal("delivered"),
  Type.Literal("failed"),
]);
export type OrbMessageStatus = Static<typeof OrbMessageStatusSchema>;

export const OrbMessageViewSchema = Type.Object(
  {
    id: Type.String(),
    orbId: Type.String(),
    content: Type.Array(MessageInputBlockSchema),
    status: OrbMessageStatusSchema,
    delivery: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("steer")])),
    operationId: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  closed,
);
export type OrbMessageView = Static<typeof OrbMessageViewSchema>;

export const OrbMessageListViewSchema = Type.Object(
  { items: Type.Array(OrbMessageViewSchema) },
  closed,
);
export type OrbMessageListView = Static<typeof OrbMessageListViewSchema>;

export const ControlPlaneHttpErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Union([
          Type.Literal("invalid_request"),
          Type.Literal("not_found"),
          Type.Literal("conflict"),
          Type.Literal("unavailable"),
          Type.Literal("internal"),
        ]),
        message: Type.String(),
        retryable: Type.Boolean(),
      },
      closed,
    ),
  },
  closed,
);
export type ControlPlaneHttpError = Static<typeof ControlPlaneHttpErrorSchema>;

export function ListResponseSchema<T extends TSchema>(item: T) {
  return Type.Object({ items: Type.Array(item) }, closed);
}
