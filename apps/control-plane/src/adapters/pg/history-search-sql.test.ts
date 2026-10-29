import { readFileSync } from "node:fs";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { StoreError } from "../../domain/errors.ts";
import type { PostgreSQLClient } from "./client.ts";
import { HISTORY_SEARCH_SQL, searchHistory } from "./history-search.ts";

describe("native history search", () => {
  it("uses one ordered BM25 scan with eligibility before the limit", () => {
    expect(HISTORY_SEARCH_SQL).toContain("OPERATOR(public.<@>) public.to_bm25query(");
    expect(HISTORY_SEARCH_SQL).toContain("ranked AS MATERIALIZED");
    expect(HISTORY_SEARCH_SQL).toMatch(
      /WHERE[\s\S]*SELECT orb_id,record_id FROM chain[\s\S]*ORDER BY[\s\S]*LIMIT \$5/u,
    );
    expect(HISTORY_SEARCH_SQL).not.toMatch(
      /history_search_tokens|history_search_keys|document_count|candidate_count|avgdl/u,
    );
  });

  it("replaces the GIN index and removes its helpers without projection state", () => {
    const sql = readFileSync(
      new URL("./migrations/052_native_history_search.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_textsearch");
    expect(sql).toContain("DROP INDEX history_records_search_idx");
    expect(sql).toContain("DROP FUNCTION history_search_keys(json)");
    expect(sql).toContain("DROP FUNCTION history_search_tokens(text)");
    expect(sql).toMatch(/USING bm25\s*\(history_search_public_text\(record\)\)/u);
    expect(sql).not.toMatch(/CREATE TABLE|ADD COLUMN|CREATE TRIGGER/u);
  });

  it("returns only hit diagnostics and keeps typed database failures private", async () => {
    const failure: StoreError = {
      type: "store_error",
      code: "unavailable",
      retryable: true,
      message: "private SQL",
      sqlState: "57014",
    };
    const query = vi.fn().mockReturnValue(okAsync({ rows: [], rowCount: 0 }));
    const db = { query } as unknown as PostgreSQLClient;
    const params = { ownerUserId: "owner", query: "private query", limit: 10 };
    expect((await searchHistory(db, params))._unsafeUnwrap()).toEqual({ hits: [] });
    query.mockReturnValue(errAsync(failure));
    expect((await searchHistory(db, params))._unsafeUnwrapErr()).toEqual({
      ...failure,
      message: "history search failed",
    });
  });
});
