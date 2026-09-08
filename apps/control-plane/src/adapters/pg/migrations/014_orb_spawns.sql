-- Immutable acceptance doubles as provenance and a retry tombstone. Neither
-- caller nor target is a FK: deleting either must not delete/recreate work.
-- Project deletion removes the tombstones along with that project's data.
CREATE TABLE orb_spawns (
  orb_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  caller_orb_id uuid NOT NULL,
  caller_incarnation bigint NOT NULL,
  request_hash text NOT NULL,
  accepted_at timestamptz NOT NULL
);
CREATE INDEX orb_spawns_caller_idx ON orb_spawns(caller_orb_id);
