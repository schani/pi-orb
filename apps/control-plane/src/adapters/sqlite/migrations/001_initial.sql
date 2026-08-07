CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (trim(name) <> ''),
  repository_url TEXT NOT NULL CHECK (trim(repository_url) <> ''),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE orbs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  state TEXT NOT NULL CHECK (state IN ('creating','starting','running','stopping','stopped','failed')),
  state_version INTEGER NOT NULL DEFAULT 0,
  host_kind TEXT NOT NULL,
  host_ref TEXT,
  checkout_commit TEXT,
  harness_session_id TEXT,
  harness_session_header TEXT CHECK (harness_session_header IS NULL OR json_valid(harness_session_header)),
  last_error TEXT,
  runtime_token_hash TEXT,
  replication_cursor TEXT,
  replicated_head_id TEXT,
  last_busy_at INTEGER,
  stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason = 'idle'),
  state_changed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((harness_session_id IS NULL) = (harness_session_header IS NULL)),
  CHECK (harness_session_header IS NULL OR json_extract(harness_session_header, '$.id') = harness_session_id),
  FOREIGN KEY (id, replication_cursor) REFERENCES history_records(orb_id, record_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, replicated_head_id) REFERENCES history_records(orb_id, record_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX orbs_project_id_idx ON orbs(project_id);
CREATE INDEX orbs_state_idx ON orbs(state);
CREATE INDEX orbs_runtime_token_hash_idx ON orbs(runtime_token_hash) WHERE runtime_token_hash IS NOT NULL;

CREATE TABLE history_records (
  orb_id TEXT NOT NULL REFERENCES orbs(id),
  record_id TEXT NOT NULL,
  parent_id TEXT,
  record TEXT NOT NULL CHECK (json_valid(record)),
  inserted_at INTEGER NOT NULL,
  PRIMARY KEY (orb_id, record_id),
  FOREIGN KEY (orb_id, parent_id) REFERENCES history_records(orb_id, record_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (json_extract(record, '$.id') = record_id),
  CHECK (json_extract(record, '$.parentId') IS parent_id)
) STRICT;

CREATE INDEX history_records_parent_idx ON history_records(orb_id, parent_id);

CREATE TABLE credential_pointers (
  provider TEXT PRIMARY KEY,
  row_version INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  secret_version TEXT,
  refresh_lease_until INTEGER NOT NULL DEFAULT 0,
  last_refresh_at INTEGER NOT NULL DEFAULT 0
) STRICT;
