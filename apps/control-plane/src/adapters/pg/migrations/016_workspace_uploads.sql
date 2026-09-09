ALTER TABLE orbs ADD COLUMN upload_active_until timestamptz;
CREATE TABLE workspace_uploads (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  incarnation bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('transferring','finalizing','stored','notified','cancelled')),
  offset_bytes bigint NOT NULL DEFAULT 0,
  path text,
  sha256 text,
  error text,
  active_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (orb_id, id)
);
