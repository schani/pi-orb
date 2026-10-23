import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  HISTORY_SEARCH_PATH,
  HistorySearchErrorSchema,
  HistorySearchRequestSchema,
  HistorySearchResponseSchema,
  HistorySearchResultSchema,
} from "./history-search.ts";

describe("history search wire contract", () => {
  it("keeps queries in a POST body", () => {
    expect(HISTORY_SEARCH_PATH).toBe("/runtime/v1/history/search");
  });
  it.each([
    { query: "needle" },
    { query: "needle", orbId: "other" },
    { query: "needle", scope: "orb", orbId: "other", limit: 50 },
    { query: "needle", scope: "project", limit: 1 },
    { query: "x", scope: "project", orbId: "other" },
    { query: "x", scope: "user", orbId: "other" },
    { query: "!?", scope: "user" },
  ])("accepts %j", (request) => expect(Check(HistorySearchRequestSchema, request)).toBe(true));
  it.each([
    {},
    { query: "" },
    { query: "  \n " },
    { query: 1 },
    { query: "x", scope: "all" },
    { query: "x", ownerUserId: "injected" },
    { query: "x", projectId: "injected" },
    { query: "x", orbId: "" },
    ...[0, 51, -1, 2.5, "10", null].map((limit) => ({ query: "x", limit })),
  ])("rejects %j", (request) => expect(Check(HistorySearchRequestSchema, request)).toBe(false));
  it("validates public metadata without allowing private records", () => {
    const hit = {
      orbId: "o",
      sessionId: "s",
      recordId: "r",
      name: null,
      projectName: "Project",
      snippet: "needle",
      score: 0.5,
      orbUrl: "https://app/orbs/o",
    };
    expect(Check(HistorySearchResultSchema, { hits: [hit] })).toBe(true);
    expect(Check(HistorySearchResponseSchema, { v: 1, hits: [hit] })).toBe(true);
    for (const bad of [
      { ...hit, record: {} },
      { ...hit, snippet: 1 },
      { ...hit, score: "0.5" },
      { ...hit, sessionId: undefined },
      { ...hit, name: undefined },
    ])
      expect(Check(HistorySearchResponseSchema, { v: 1, hits: [bad] })).toBe(false);
  });
  it.each(["invalid_request", "not_found", "conflict", "unavailable", "internal"])(
    "validates typed %s failures",
    (code) =>
      expect(
        Check(HistorySearchErrorSchema, {
          v: 1,
          error: { code, message: "history search failed", retryable: code === "unavailable" },
        }),
      ).toBe(true),
  );
});
