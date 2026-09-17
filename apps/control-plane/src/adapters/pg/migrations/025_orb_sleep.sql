ALTER TABLE orbs DROP CONSTRAINT orbs_stop_reason_check;
ALTER TABLE orbs ADD CONSTRAINT orbs_stop_reason_check
  CHECK (stop_reason IN ('idle', 'sleep'));

ALTER TABLE orbs
  ADD COLUMN sleep_id uuid,
  ADD COLUMN sleep_until timestamptz,
  ADD CONSTRAINT orbs_sleep_pair CHECK ((sleep_id IS NULL) = (sleep_until IS NULL));

CREATE INDEX orbs_sleep_due_idx ON orbs (sleep_until) WHERE sleep_until IS NOT NULL;

ALTER TABLE orb_messages ADD COLUMN system jsonb CHECK (
  system IS NULL OR (
    jsonb_typeof(system) = 'object'
    AND system ?& ARRAY['kind', 'sleepUntil']
    AND COALESCE(system->>'kind' IN ('sleep_wake', 'sleep_expired'), false)
    AND jsonb_typeof(system->'sleepUntil') = 'string'
    AND system - 'kind' - 'sleepUntil' = '{}'::jsonb
  )
);
