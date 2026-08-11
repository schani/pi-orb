-- Message-driven startup goes through the lifecycle CAS only (docs/lifecycle.md,
-- 2026-08-11): enqueue records the wake intent, the reconciler's terminal
-- backstop performs the transition. `wake_state_version` is the orb
-- `state_version` the intent was admitted against. A `stopped` orb wakes for
-- any outstanding intent; a `failed` orb wakes only for an intent naming its
-- current version, so a new send retries a failed boot exactly once while a
-- stranded intent never does.
ALTER TABLE orb_messages ADD COLUMN wake_state_version bigint;
