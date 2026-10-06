ALTER TABLE orbs ADD COLUMN last_ready_at timestamptz;
UPDATE orbs SET last_ready_at = updated_at WHERE checkout_commit IS NOT NULL;
