-- Project-scoped write-only environment secrets (docs/credentials.md).
-- Values live only in the immutable secret store; PostgreSQL holds metadata
-- and the exact version pointer needed for coherent boot snapshots.
CREATE TABLE project_secret_pointers (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  row_version bigint NOT NULL CHECK (row_version > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  entries jsonb NOT NULL,
  secret_version text NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(entries) = 'object')
);
