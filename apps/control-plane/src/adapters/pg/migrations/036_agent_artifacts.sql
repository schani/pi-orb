CREATE TABLE orb_agent_artifacts (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 16777216),
  PRIMARY KEY (orb_id, id)
);
