ALTER TABLE orbs ADD COLUMN harness text NOT NULL DEFAULT 'pi'
  CHECK (harness IN ('pi', 'claude'));
