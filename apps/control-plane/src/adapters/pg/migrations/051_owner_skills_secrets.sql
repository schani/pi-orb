-- Owner-level skills and secrets apply to every project of the owner
-- (docs/owner-skills-secrets.md). Skills are readable Markdown, one row each;
-- owner secrets mirror project_secret_pointers: values live only in the
-- immutable secret store, PostgreSQL holds metadata and the version pointer.
CREATE TABLE user_skills (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
  content text NOT NULL CHECK (octet_length(content) <= 65536),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE user_secret_pointers (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  row_version bigint NOT NULL CHECK (row_version > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  entries jsonb NOT NULL,
  secret_version text NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(entries) = 'object')
);
