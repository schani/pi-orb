import { type Static, type TSchema, Type } from "typebox";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";

const closed = { additionalProperties: false } as const;

export const OrbStateSchema = Type.Union([
  Type.Literal("creating"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("stopped"),
  Type.Literal("failed"),
]);
export type OrbState = Static<typeof OrbStateSchema>;

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
  },
  closed,
);
export type CreateOrbRequest = Static<typeof CreateOrbRequestSchema>;

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

export const OrbStateDetailSchema = Type.Object(
  {
    type: Type.Literal("draining_history"),
    retrying: Type.Boolean(),
    message: Type.Optional(Type.String()),
  },
  closed,
);
export type OrbStateDetail = Static<typeof OrbStateDetailSchema>;

export const OrbActionRequiredSchema = Type.Object(
  {
    type: Type.Literal("openai_codex_device_login"),
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
    state: OrbStateSchema,
    stateVersion: Type.Number(),
    checkoutCommit: Type.Optional(Type.String()),
    lastError: Type.Optional(Type.String()),
    /** Synthesized from in-memory reconciler state; never stored. */
    stateDetail: Type.Optional(OrbStateDetailSchema),
    stateChangedAt: Type.String(),
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
