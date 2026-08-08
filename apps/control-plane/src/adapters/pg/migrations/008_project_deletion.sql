-- Durable whole-project deletion (docs/project-deletion.md).
ALTER TABLE projects ADD COLUMN state text NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'deleting'));
ALTER TABLE projects ADD COLUMN state_version bigint NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE projects ADD COLUMN deletion_initial_orb_count integer;
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX projects_deleting_idx ON projects(state) WHERE state = 'deleting';
