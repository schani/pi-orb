CREATE TABLE IF NOT EXISTS history_search_documents (
  orb_id uuid NOT NULL,
  record_id text NOT NULL,
  token_count integer NOT NULL CHECK (token_count >= 0),
  term_frequencies jsonb NOT NULL CHECK (jsonb_typeof(term_frequencies) = 'object'),
  PRIMARY KEY (orb_id, record_id),
  FOREIGN KEY (orb_id, record_id)
    REFERENCES history_records(orb_id, record_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS history_search_documents_terms_idx
  ON history_search_documents USING gin (term_frequencies jsonb_ops);
