ALTER TABLE orbs ADD COLUMN claude_recovery jsonb;
ALTER TABLE orbs DROP CONSTRAINT orbs_host_discard_reason_valid;
ALTER TABLE orbs ADD CONSTRAINT orbs_host_discard_reason_valid
  CHECK (host_discard_reason IN ('failed', 'host_spec_changed', 'claude_recovery'));
