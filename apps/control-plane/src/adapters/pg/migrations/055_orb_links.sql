-- In-progress GitHub links an orb's agent registered (docs/orb-links.md).
CREATE TABLE orb_links (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  url text NOT NULL,
  added_at timestamptz NOT NULL,
  PRIMARY KEY (orb_id, url)
);
