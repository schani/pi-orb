ALTER TABLE orbs DROP CONSTRAINT orbs_stop_reason_check;
ALTER TABLE orbs ADD CONSTRAINT orbs_stop_reason_check
  CHECK (stop_reason IN ('idle', 'sleep', 'manual'));

UPDATE orbs SET stop_reason = 'manual'
WHERE state IN ('stopped', 'stopping') AND stop_reason IS NULL;
