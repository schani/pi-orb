import { type Static, type TSchema, Type } from "typebox";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";
import { ORB_NAME_MAX_CHARS } from "./orb-naming.ts";

const closed = { additionalProperties: false } as const;

export const OrbStateSchema = Type.Union([
  Type.Literal("creating"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("stopped"),
  Type.Literal("failed"),
  Type.Literal("deleting"),
]);
export type OrbState = Static<typeof OrbStateSchema>;

/** Why an orb last entered `stopping`; absent for explicit stops (docs/lifecycle.md). */
export const StopReasonSchema = Type.Literal("idle");
export type StopReason = Static<typeof StopReasonSchema>;

export const CreateProjectRequestSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    repositoryUrl: Type.String(),
  },
  closed,
);
export type CreateProjectRequest = Static<typeof CreateProjectRequestSchema>;

export const CreateOrbRequestSchema = Type.Object(
  {
    id: Type.String(),
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

export const ProjectViewSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    repositoryUrl: Type.String(),
    createdAt: Type.String(),
  },
  closed,
);
export type ProjectView = Static<typeof ProjectViewSchema>;

export const OrbStateDetailSchema = Type.Union([
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
      type: Type.Literal("waiting_for_runtime"),
      hostState: Type.Union([Type.String(), Type.Null()]),
      secondsSinceHostRunning: Type.Union([Type.Number(), Type.Null()]),
      probeAttempts: Type.Number(),
      lastProbeError: Type.Optional(Type.String()),
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

export const OrbViewSchema = Type.Object(
  {
    id: Type.String(),
    projectId: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    state: OrbStateSchema,
    stateVersion: Type.Number(),
    checkoutCommit: Type.Optional(Type.String()),
    lastError: Type.Optional(Type.String()),
    /** Synthesized from in-memory reconciler state; never stored. */
    stateDetail: Type.Optional(OrbStateDetailSchema),
    /** Present when the last stop was automatic ("stopped (idle)", docs/lifecycle.md). */
    stopReason: Type.Optional(StopReasonSchema),
    stateChangedAt: Type.String(),
    /**
     * MagicDNS host every port inside the orb is reachable at (docs/ports.md).
     * Derived from the orb id and the configured tailnet, never stored;
     * absent when tailscale port exposure is not configured.
     */
    previewHost: Type.Optional(Type.String()),
    /** Synthesized from the in-memory device flow; never stored. */
    actionRequired: Type.Optional(OrbActionRequiredSchema),
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
