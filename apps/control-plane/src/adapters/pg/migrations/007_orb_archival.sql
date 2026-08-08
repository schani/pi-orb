-- Irreversible read-only orb archival (docs/orb-archival.md).
ALTER TABLE orbs DROP CONSTRAINT orbs_state_check;
ALTER TABLE orbs ADD CONSTRAINT orbs_state_check CHECK (state IN (
  'creating', 'starting', 'running', 'stopping', 'stopped', 'failed', 'deleting',
  'archiving', 'archived'
));
ALTER TABLE orbs ADD COLUMN archived_at timestamptz;

-- The deletion tombstone becomes the shared, durable cleanup intent. Existing
-- rows are permanent deletions.
ALTER TABLE orb_deletions ADD COLUMN kind text NOT NULL DEFAULT 'delete'
  CHECK (kind IN ('archive', 'delete'));
ALTER TABLE orb_deletions ADD COLUMN history_sealed_at timestamptz;
ALTER TABLE orb_deletions ADD COLUMN sealed_cursor text;
ALTER TABLE orb_deletions ADD COLUMN sealed_head_id text;
