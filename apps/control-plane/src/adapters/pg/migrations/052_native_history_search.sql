CREATE EXTENSION IF NOT EXISTS pg_textsearch WITH SCHEMA public;

DROP INDEX history_records_search_idx;
DROP FUNCTION history_search_keys(json);
DROP FUNCTION history_search_tokens(text);

CREATE INDEX history_records_search_idx ON history_records
  USING bm25(history_search_public_text(record)) WITH (text_config='english');
