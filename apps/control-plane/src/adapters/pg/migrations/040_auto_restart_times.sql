ALTER TABLE orbs ADD COLUMN auto_restart_times timestamptz[] NOT NULL DEFAULT '{}';
