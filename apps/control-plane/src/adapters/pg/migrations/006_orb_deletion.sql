-- Durable, crash-recoverable permanent orb deletion (docs/orb-deletion.md).
ALTER TABLE orbs DROP CONSTRAINT orbs_state_check;
ALTER TABLE orbs ADD CONSTRAINT orbs_state_check CHECK (state IN (
  'creating', 'starting', 'running', 'stopping', 'stopped', 'failed', 'deleting'
));

CREATE TABLE orb_deletions (
  orb_id uuid PRIMARY KEY,
  host_kind text NOT NULL,
  requested_at timestamptz NOT NULL,
  cleanup_after timestamptz NOT NULL,
  last_error text,
  updated_at timestamptz NOT NULL
);

CREATE INDEX orb_deletions_cleanup_after_idx ON orb_deletions(cleanup_after);
