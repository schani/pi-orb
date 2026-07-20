-- pi-orb initial schema (DESIGN.md §8.6). Three tables only.

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  repository_url text NOT NULL CHECK (btrim(repository_url) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orbs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),

  state text NOT NULL CHECK (state IN (
    'creating', 'starting', 'running', 'stopping', 'stopped', 'failed'
  )),
  state_version bigint NOT NULL DEFAULT 0,

  host_kind text NOT NULL,
  host_ref text,
  checkout_commit text,
  harness_session_id text,
  harness_session_header jsonb CHECK (
    harness_session_header IS NULL OR jsonb_typeof(harness_session_header) = 'object'
  ),
  CHECK ((harness_session_id IS NULL) = (harness_session_header IS NULL)),
  CHECK (
    harness_session_header IS NULL OR harness_session_header->>'id' = harness_session_id
  ),
  last_error text,

  replication_cursor text,
  replicated_head_id text,

  state_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orbs_project_id_idx ON orbs(project_id);
CREATE INDEX orbs_state_idx ON orbs(state);

CREATE TABLE history_records (
  orb_id uuid NOT NULL REFERENCES orbs(id),
  record_id text NOT NULL,
  parent_id text,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  inserted_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (orb_id, record_id),
  FOREIGN KEY (orb_id, parent_id)
    REFERENCES history_records(orb_id, record_id)
    DEFERRABLE INITIALLY DEFERRED,

  CHECK (record->>'id' = record_id),
  CHECK ((record->>'parentId') IS NOT DISTINCT FROM parent_id)
);

CREATE INDEX history_records_parent_idx
  ON history_records(orb_id, parent_id);

ALTER TABLE orbs ADD CONSTRAINT orbs_replication_cursor_fk
  FOREIGN KEY (id, replication_cursor)
  REFERENCES history_records(orb_id, record_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE orbs ADD CONSTRAINT orbs_replicated_head_fk
  FOREIGN KEY (id, replicated_head_id)
  REFERENCES history_records(orb_id, record_id)
  DEFERRABLE INITIALLY DEFERRED;
