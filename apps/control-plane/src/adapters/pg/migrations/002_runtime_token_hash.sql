-- Per-host-incarnation runtime-token hash (DESIGN.md §15.1). The plaintext
-- token lives only in the host's delivery channel; this hash authorizes the
-- runtime-facing broker routes. Indexed for the bearer-token lookup.
ALTER TABLE orbs ADD COLUMN runtime_token_hash text;
CREATE INDEX orbs_runtime_token_hash_idx ON orbs (runtime_token_hash)
  WHERE runtime_token_hash IS NOT NULL;
