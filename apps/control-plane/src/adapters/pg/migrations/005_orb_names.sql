-- User-assigned and Luna-generated orb display names. Generation coordinates
-- with a lease/backoff on the orb row; no background-job table is needed.
ALTER TABLE orbs ADD COLUMN name text CHECK (
  name IS NULL OR (btrim(name) <> '' AND char_length(name) <= 80)
);
ALTER TABLE orbs ADD COLUMN auto_name_lease_until timestamptz;
ALTER TABLE orbs ADD COLUMN auto_name_attempts integer NOT NULL DEFAULT 0
  CHECK (auto_name_attempts >= 0);
ALTER TABLE orbs ADD COLUMN auto_name_next_attempt_at timestamptz;
