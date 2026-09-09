CREATE TABLE project_mcp (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  servers jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
