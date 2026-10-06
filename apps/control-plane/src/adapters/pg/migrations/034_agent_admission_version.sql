ALTER TABLE orbs ADD COLUMN agent_admission_version bigint NOT NULL DEFAULT 0 CHECK (agent_admission_version >= 0);
