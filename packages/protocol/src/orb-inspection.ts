import { type Static, Type } from "typebox";
import { OrbStateSchema } from "./control-plane-api.ts";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";

const closed = { additionalProperties: false } as const;

export const ORB_INSPECTION_LIST_PATH = "/runtime/v1/orbs";

export function orbTranscriptPath(orbId: string): string {
  return `${ORB_INSPECTION_LIST_PATH}/${encodeURIComponent(orbId)}/transcript`;
}

const OrbInspectionProjectSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    repositoryUrl: Type.String(),
  },
  closed,
);

export const OrbInspectionItemSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    state: OrbStateSchema,
    updatedAt: Type.String(),
    project: OrbInspectionProjectSchema,
  },
  closed,
);
export type OrbInspectionItem = Static<typeof OrbInspectionItemSchema>;

export const OrbInspectionListSchema = Type.Object(
  {
    v: Type.Literal(1),
    currentOrbId: Type.String(),
    items: Type.Array(OrbInspectionItemSchema),
  },
  closed,
);
export type OrbInspectionList = Static<typeof OrbInspectionListSchema>;

export const OrbTranscriptSchema = Type.Object(
  {
    v: Type.Literal(1),
    orb: OrbInspectionItemSchema,
    session: Type.Union([HarnessSessionMetadataSchema, Type.Null()]),
    cursor: Type.Union([Type.String(), Type.Null()]),
    headId: Type.Union([Type.String(), Type.Null()]),
    records: Type.Array(HistoryRecordSchema),
  },
  closed,
);
export type OrbTranscript = Static<typeof OrbTranscriptSchema>;

export const OrbInspectionErrorSchema = Type.Object(
  {
    v: Type.Literal(1),
    error: Type.Object(
      {
        code: Type.Union([
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
export type OrbInspectionError = Static<typeof OrbInspectionErrorSchema>;
