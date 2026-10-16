-- Per-host-incarnation runtime-token hash (docs/credentials.md). The plaintext
-- token lives only in the host's delivery channel; this hash authorizes the
-- runtime-facing broker routes.
ALTER TABLE orbs ADD COLUMN runtime_token_hash text;
CREATE INDEX orbs_runtime_token_hash_idx ON orbs (runtime_token_hash)
  WHERE runtime_token_hash IS NOT NULL;
