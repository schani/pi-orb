CREATE TABLE orb_resource_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  admission_version bigint NOT NULL,
  phase text NOT NULL CHECK (phase IN ('acquiring', 'ready', 'failed')),
  error_code text,
  commit_sha text,
  file_count integer,
  byte_count bigint,
  UNIQUE (orb_id, admission_version, phase)
);
