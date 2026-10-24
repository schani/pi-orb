import { type Static, Type } from "typebox";
import { OrbStateSchema } from "./control-plane-api.ts";
import { HarnessSessionMetadataSchema, HistoryRecordSchema } from "./history.ts";

const closed = { additionalProperties: false } as const;

export const ORB_INSPECTION_LIST_PATH = "/runtime/v1/orbs";
export const ORB_SELF_PATH = "/runtime/v1/orb/self";

export const OrbSelfSchema = Type.Object(
  {
    v: Type.Literal(1),
    orb: Type.Object(
      {
        id: Type.String(),
        name: Type.Union([Type.String(), Type.Null()]),
        url: Type.String(),
        createdAt: Type.String(),
      },
      closed,
    ),
    project: Type.Object(
      {
        id: Type.String(),
        name: Type.String(),
        repositoryUrl: Type.Union([Type.String(), Type.Null()]),
      },
      closed,
    ),
    spawnedByOrb: Type.Union([
      Type.Object({ id: Type.String(), url: Type.String() }, closed),
      Type.Null(),
    ]),
    children: Type.Array(
      Type.Object(
        { id: Type.String(), name: Type.Union([Type.String(), Type.Null()]), url: Type.String() },
        closed,
      ),
    ),
    previewHost: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export type OrbSelf = Static<typeof OrbSelfSchema>;

export function orbTranscriptPath(orbId: string): string {
  return `${ORB_INSPECTION_LIST_PATH}/${encodeURIComponent(orbId)}/transcript`;
}

const OrbInspectionProjectSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    repositoryUrl: Type.Union([Type.String(), Type.Null()]),
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
export type OrbInspectionError = Static<typeof OrbInspectionErrorSchema>;

export const HISTORY_SEARCH_PATH = "/runtime/v1/history/search";
export const HISTORY_SEARCH_MAX_LIMIT = 50;

export const HistorySearchRequestSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" }),
    scope: Type.Optional(
      Type.Union([Type.Literal("orb"), Type.Literal("project"), Type.Literal("user")]),
    ),
    orbId: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_SEARCH_MAX_LIMIT })),
  },
  closed,
);
export type HistorySearchRequest = Static<typeof HistorySearchRequestSchema>;

export const HistorySearchHitSchema = Type.Object(
  {
    orbId: Type.String(),
    sessionId: Type.String(),
    recordId: Type.String(),
    name: Type.Union([Type.String(), Type.Null()]),
    projectName: Type.String(),
    snippet: Type.String(),
    score: Type.Number(),
    orbUrl: Type.String(),
  },
  closed,
);
export type HistorySearchHit = Static<typeof HistorySearchHitSchema>;

const hits = Type.Array(HistorySearchHitSchema, { maxItems: HISTORY_SEARCH_MAX_LIMIT });
export const HistorySearchResultSchema = Type.Object({ hits }, closed);
export type HistorySearchResult = Static<typeof HistorySearchResultSchema>;
export const HistorySearchResponseSchema = Type.Object({ v: Type.Literal(1), hits }, closed);
export type HistorySearchResponse = Static<typeof HistorySearchResponseSchema>;
