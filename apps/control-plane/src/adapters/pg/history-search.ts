import type { ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { HistorySearchPage, HistorySearchParams } from "../../domain/ports.ts";
import { jsonParam, type PostgreSQLClient } from "./client.ts";

/** Eligibility is evaluated inside the ordered scan, before the native top-k limit. */
export const HISTORY_SEARCH_SQL = `
WITH RECURSIVE
query_terms AS MATERIALIZED (
  SELECT part[1] AS term FROM regexp_matches(
    lower(normalize(history_search_safe_json($4::json) ->> 'query',NFKC) COLLATE "C.utf8"),
    '[[:alnum:]]+', 'g'
  ) AS matched(part)
),
scope AS MATERIALIZED (
  SELECT o.id AS orb_id, o.harness, o.replication_cursor, o.harness_session_id,
         o.name, p.name AS project_name
  FROM orbs o JOIN projects p ON p.id=o.project_id
  WHERE p.owner_user_id=$1 AND p.state <> 'deleting' AND o.state <> 'deleting'
    AND ($2::uuid IS NULL OR p.id=$2::uuid)
    AND ($3::uuid IS NULL OR o.id=$3::uuid)
    AND o.harness_session_id IS NOT NULL AND o.replication_cursor IS NOT NULL
),
chain AS (
  SELECT h.orb_id,h.record_id,h.parent_id FROM history_records h JOIN scope s
    ON s.orb_id=h.orb_id AND s.replication_cursor=h.record_id WHERE s.harness='pi'
  UNION
  SELECT h.orb_id,h.record_id,h.parent_id FROM history_records h JOIN chain c
    ON c.orb_id=h.orb_id AND c.parent_id=h.record_id
),
ranked AS MATERIALIZED (
  SELECT h.orb_id,h.record_id,history_search_public_text(h.record)
    OPERATOR(public.<@>) public.to_bm25query(history_search_safe_json($4::json) ->> 'query','history_records_search_idx') AS distance
  FROM history_records h
  WHERE h.orb_id IN (SELECT orb_id FROM scope WHERE harness='claude')
    OR (h.orb_id,h.record_id) IN (SELECT orb_id,record_id FROM chain)
  ORDER BY distance
  LIMIT $5
)
SELECT r.orb_id,r.record_id,-r.distance AS score,s.harness_session_id,s.name,s.project_name,
       substring(e.public_text FROM greatest(1,least(coalesce(location.first_match,1)-100,length(e.public_text)-249)) FOR 250) AS snippet
FROM ranked r
JOIN scope s ON s.orb_id=r.orb_id
JOIN history_records h ON h.orb_id=r.orb_id AND h.record_id=r.record_id
CROSS JOIN LATERAL (SELECT history_search_public_text(h.record) AS public_text) e
LEFT JOIN LATERAL (
  SELECT min(nullif(strpos(lower(e.public_text COLLATE "C.utf8"),term),0)) AS first_match FROM query_terms
) location ON true
WHERE r.distance < 0
ORDER BY r.distance
`;

export function searchHistory(
  db: PostgreSQLClient,
  params: HistorySearchParams,
): ResultAsync<HistorySearchPage, StoreError> {
  return db
    .query(HISTORY_SEARCH_SQL, [
      params.ownerUserId,
      params.projectId ?? null,
      params.orbId ?? null,
      jsonParam({ query: params.query }),
      params.limit,
    ])
    .map(({ rows }) => ({
      hits: rows.map((row) => ({
        orbId: String(row["orb_id"]),
        sessionId: String(row["harness_session_id"]),
        recordId: String(row["record_id"]),
        name: row["name"] == null ? null : String(row["name"]),
        projectName: String(row["project_name"]),
        snippet: String(row["snippet"]),
        score: Number(row["score"]),
      })),
    }))
    .mapErr((error) => ({ ...error, message: "history search failed" }));
}
