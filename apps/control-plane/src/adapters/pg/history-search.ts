import type { ResultAsync } from "neverthrow";
import type { StoreError } from "../../domain/errors.ts";
import type { HistorySearchPage, HistorySearchParams } from "../../domain/ports.ts";
import { jsonParam, type PostgreSQLClient } from "./client.ts";

/** One statement snapshot; corpus lengths require parsing all eligible public source records. */
export const HISTORY_SEARCH_SQL = `
WITH RECURSIVE
query_terms AS MATERIALIZED (
  SELECT DISTINCT unnest(history_search_tokens(history_search_safe_json($4::json) ->> 'query')) AS term
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
public_documents AS MATERIALIZED (
  SELECT h.orb_id,h.record_id,normalize(history_search_public_text(h.record),NFKC) AS public_text
  FROM history_records h JOIN scope s ON s.orb_id=h.orb_id
  WHERE s.harness='claude' OR EXISTS (
    SELECT 1 FROM chain c WHERE c.orb_id=h.orb_id AND c.record_id=h.record_id
  )
),
tokenized AS MATERIALIZED (
  SELECT *,history_search_tokens(public_text) AS tokens FROM public_documents
),
eligible AS MATERIALIZED (
  SELECT *,cardinality(tokens) AS dl FROM tokenized WHERE cardinality(tokens)>0
),
stats AS (
  SELECT count(*)::integer AS document_count,avg(dl)::double precision AS avgdl FROM eligible
),
term_candidates AS MATERIALIZED (
  SELECT h.orb_id,h.record_id FROM history_records h JOIN scope s ON s.orb_id=h.orb_id
  WHERE history_search_keys(h.record) && ARRAY(SELECT md5(term) FROM query_terms)
),
tf AS MATERIALIZED (
  SELECT c.orb_id,c.record_id,e.dl,t.term,count(*)::double precision AS tf
  FROM term_candidates c JOIN eligible e USING(orb_id,record_id)
  CROSS JOIN LATERAL unnest(e.tokens) t(term) JOIN query_terms q ON q.term=t.term
  GROUP BY c.orb_id,c.record_id,e.dl,t.term
),
df AS (
  SELECT term,count(*)::double precision AS df FROM tf GROUP BY term
),
ranked AS (
  SELECT tf.orb_id,tf.record_id,sum(ln(1.0+(s.document_count-df.df+0.5)/(df.df+0.5))
    *tf.tf*2.2/(tf.tf+1.2*(0.25+0.75*tf.dl/s.avgdl))) AS score
  FROM tf JOIN df USING(term) CROSS JOIN stats s
  GROUP BY tf.orb_id,tf.record_id
  ORDER BY score DESC,tf.orb_id::text COLLATE "C",tf.record_id COLLATE "C"
  LIMIT $5
)
SELECT stats.document_count,
       (SELECT count(*)::integer FROM (SELECT DISTINCT orb_id,record_id FROM tf) matches) AS candidate_count,
       r.orb_id,r.record_id,r.score,s.harness_session_id,s.name,s.project_name,
       substring(e.public_text FROM greatest(1,least(coalesce(location.first_match,1)-100,length(e.public_text)-249)) FOR 250) AS snippet
FROM stats
LEFT JOIN ranked r ON true
LEFT JOIN scope s ON s.orb_id=r.orb_id
LEFT JOIN eligible e ON e.orb_id=r.orb_id AND e.record_id=r.record_id
LEFT JOIN LATERAL (
  SELECT min(nullif(strpos(lower(e.public_text COLLATE "C.utf8"),term),0)) AS first_match FROM query_terms
) location ON true
ORDER BY r.score DESC,r.orb_id::text COLLATE "C",r.record_id COLLATE "C"
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
          snippet: String(row["snippet"]),
          score: Number(row["score"]),
        })),
    }))
    .mapErr((error) => ({ ...error, message: "history search failed" }));
}
