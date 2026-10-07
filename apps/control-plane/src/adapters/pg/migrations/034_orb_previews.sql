ALTER TABLE orbs ADD COLUMN preview_active_until timestamptz;

CREATE TABLE orb_previews (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  registration_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (orb_id, port)
);
