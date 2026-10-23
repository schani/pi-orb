import { type Static, Type } from "typebox";

const closed = { additionalProperties: false } as const;

export const HISTORY_SEARCH_PATH = "/runtime/v1/history/search";
export const HISTORY_SEARCH_DEFAULT_LIMIT = 10;
export const HISTORY_SEARCH_MAX_LIMIT = 50;

export const HistorySearchRequestSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, pattern: "\\S" }),
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

export const HistorySearchErrorSchema = Type.Object(
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
export type HistorySearchError = Static<typeof HistorySearchErrorSchema>;
