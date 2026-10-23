import type { HistoryRecord } from "@pi-orb/protocol";
import { err, ok, okAsync, ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import {
  extractHistorySearchText,
  historySearchTermFrequencies,
} from "../../domain/history-search-text.ts";
import type { HistorySearchParams, HistorySearchResult } from "../../domain/ports.ts";
import { arrayParam, jsonParam, type PostgreSQLClient } from "./client.ts";

type Query = PostgreSQLClient["query"];

function indexError(error: StoreError): StoreError {
  return { ...error, message: "history-search index failed" };
}

export function indexHistorySearchRecord(
  query: Query,
  orbId: string,
  record: HistoryRecord,
): ResultAsync<void, StoreError> {
  const { tokenCount, termFrequencies } = historySearchTermFrequencies(
    extractHistorySearchText(record),
  );
  return query(
    `INSERT INTO history_search_documents (orb_id, record_id, token_count, term_frequencies)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (orb_id, record_id) DO NOTHING`,
    [orbId, record.id, tokenCount, jsonParam(termFrequencies)],
  )
    .map(() => undefined)
    .mapErr(indexError);
}

/** The migration ledger is written only after every bounded batch commits. */
export function backfillHistorySearch(db: PostgreSQLClient): ResultAsync<number, StoreError> {
  const run = async () => {
    let indexed = 0;
    for (;;) {
      const batch = await db.transaction<number | null, StoreError>(async (query) => {
        // Use the same fence and lock order as publication and deletion.
        const orb = await query(
          `SELECT o.id FROM orbs o
           WHERE EXISTS (
             SELECT 1 FROM history_records h
             WHERE h.orb_id = o.id AND NOT EXISTS (
               SELECT 1 FROM history_search_documents d
               WHERE d.orb_id = h.orb_id AND d.record_id = h.record_id
             )
           ) ORDER BY o.id LIMIT 1 FOR UPDATE`,
        );
        if (orb.isErr()) return err(orb.error);
        const orbId = orb.value.rows[0]?.["id"];
        if (orbId === undefined) return ok(null);
        const missing = await query(
          `SELECT h.record FROM history_records h
           WHERE h.orb_id = $1 AND NOT EXISTS (
             SELECT 1 FROM history_search_documents d
             WHERE d.orb_id = h.orb_id AND d.record_id = h.record_id
           ) ORDER BY h.record_id LIMIT 500`,
          [orbId],
        );
        if (missing.isErr()) return err(missing.error);
        for (const row of missing.value.rows) {
          const result = await indexHistorySearchRecord(
            query,
            String(orbId),
            row["record"] as HistoryRecord,
          );
          if (result.isErr()) return err(result.error);
        }
        return ok(missing.value.rows.length);
      });
      if (batch.isErr()) return err(batch.error);
      if (batch.value === null) return ok(indexed);
      indexed += batch.value;
    }
  };
  return new ResultAsync(run());
}

/** One statement snapshot covers authorization, ancestry, statistics and ranking. */
export const HISTORY_SEARCH_SQL = `
WITH RECURSIVE
scope AS MATERIALIZED (
  SELECT o.id AS orb_id, o.harness, o.replication_cursor, o.harness_session_id,
         o.name, p.name AS project_name
  FROM orbs o JOIN projects p ON p.id = o.project_id
  WHERE p.owner_user_id = $1 AND p.state <> 'deleting' AND o.state <> 'deleting'
    AND ($2::uuid IS NULL OR p.id = $2::uuid)
    AND ($3::uuid IS NULL OR o.id = $3::uuid)
    AND o.harness_session_id IS NOT NULL AND o.replication_cursor IS NOT NULL
),
chain AS (
  SELECT h.orb_id, h.record_id, h.parent_id
  FROM history_records h JOIN scope s
    ON s.orb_id = h.orb_id AND s.replication_cursor = h.record_id
  WHERE s.harness = 'pi'
  UNION
  SELECT h.orb_id, h.record_id, h.parent_id
  FROM history_records h JOIN chain c ON h.orb_id = c.orb_id AND h.record_id = c.parent_id
),
eligible AS MATERIALIZED (
  SELECT d.orb_id, d.record_id, d.token_count
  FROM history_search_documents d JOIN scope s ON s.orb_id = d.orb_id
  WHERE d.token_count > 0 AND (s.harness = 'claude' OR EXISTS (
    SELECT 1 FROM chain c WHERE c.orb_id = d.orb_id AND c.record_id = d.record_id
  ))
),
stats AS (
  SELECT count(*)::integer AS document_count, avg(token_count)::double precision AS avgdl FROM eligible
),
term_candidates AS MATERIALIZED (
  SELECT d.* FROM history_search_documents d JOIN scope s ON s.orb_id = d.orb_id
  WHERE d.term_frequencies ?| $4::text[]
),
candidates AS MATERIALIZED (
  SELECT d.* FROM term_candidates d JOIN eligible e USING (orb_id, record_id)
),
terms AS (SELECT DISTINCT unnest($4::text[]) AS term),
frequencies AS (
  SELECT t.term, count(*)::double precision AS df
  FROM terms t JOIN candidates c ON c.term_frequencies ? t.term GROUP BY t.term
),
ranked AS (
  SELECT c.orb_id, c.record_id,
    sum(ln(1.0 + (s.document_count - f.df + 0.5) / (f.df + 0.5))
      * (c.term_frequencies ->> f.term)::double precision * 2.2
      / ((c.term_frequencies ->> f.term)::double precision
        + 1.2 * (0.25 + 0.75 * c.token_count / s.avgdl))) AS score
  FROM candidates c CROSS JOIN stats s
  JOIN frequencies f ON c.term_frequencies ? f.term
  GROUP BY c.orb_id, c.record_id
  ORDER BY score DESC, c.orb_id::text COLLATE "C", c.record_id COLLATE "C"
  LIMIT $5
)
SELECT stats.document_count, (SELECT count(*)::integer FROM candidates) AS candidate_count,
       r.orb_id, r.record_id, r.score, s.harness_session_id, s.name, s.project_name, h.record
FROM stats
LEFT JOIN ranked r ON true
LEFT JOIN scope s ON s.orb_id = r.orb_id
LEFT JOIN history_records h ON h.orb_id = r.orb_id AND h.record_id = r.record_id
ORDER BY r.score DESC, r.orb_id::text COLLATE "C", r.record_id COLLATE "C"
`;

export function searchHistory(
  db: PostgreSQLClient,
  params: HistorySearchParams,
): ResultAsync<HistorySearchResult, StoreError> {
  const terms = [...new Set(params.terms)];
  if (terms.length === 0) return okAsync({ hits: [], documentCount: 0, candidateCount: 0 });
  return db
    .query(HISTORY_SEARCH_SQL, [
      params.ownerUserId,
      params.projectId ?? null,
      params.orbId ?? null,
      arrayParam(terms),
      params.limit,
    ])
    .map(({ rows }) => ({
      documentCount: Number(rows[0]?.["document_count"] ?? 0),
      candidateCount: Number(rows[0]?.["candidate_count"] ?? 0),
      hits: rows
        .filter((row) => row["record_id"] != null)
        .map((row) => ({
          orbId: String(row["orb_id"]),
          sessionId: String(row["harness_session_id"]),
          recordId: String(row["record_id"]),
          name: row["name"] == null ? null : String(row["name"]),
          projectName: String(row["project_name"]),
          record: row["record"] as HistoryRecord,
          score: Number(row["score"]),
        })),
    }));
}
