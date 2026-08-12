-- Immutable compute replacement (docs/compute-replacement.md).
-- Compute identity is incarnation-bounded; authoritative workspace identity remains fixed.

ALTER TABLE orbs
  ADD COLUMN host_incarnation integer NOT NULL DEFAULT 0,
  ADD COLUMN host_spec_fingerprint text,
  ADD COLUMN host_spec_generation bigint,
  ADD COLUMN host_discard_through_incarnation integer,
  ADD COLUMN host_discard_reason text,
  ADD COLUMN host_discard_error text,
  ADD COLUMN host_discard_evidence text,
  ADD COLUMN host_discard_requested_at timestamptz,
  ADD CONSTRAINT orbs_host_incarnation_range CHECK (
    host_incarnation BETWEEN 0 AND 2147483646
  ),
  ADD CONSTRAINT orbs_host_discard_through_range CHECK (
    host_discard_through_incarnation IS NULL
      OR host_discard_through_incarnation BETWEEN 0 AND 2147483646
  ),
  ADD CONSTRAINT orbs_host_spec_generation_nonnegative CHECK (
    host_spec_generation IS NULL OR host_spec_generation >= 0
  ),
  ADD CONSTRAINT orbs_host_discard_reason_valid CHECK (
    host_discard_reason IS NULL OR host_discard_reason IN ('failed', 'host_spec_changed')
  ),
  ADD CONSTRAINT orbs_host_discard_intent_complete CHECK (
    (host_discard_through_incarnation IS NULL
      AND host_discard_reason IS NULL
      AND host_discard_requested_at IS NULL)
    OR
    (host_discard_through_incarnation IS NOT NULL
      AND host_discard_reason IS NOT NULL
      AND host_discard_requested_at IS NOT NULL)
  ),
  ADD CONSTRAINT orbs_host_spec_commit_complete CHECK (
    (host_spec_fingerprint IS NULL) = (host_spec_generation IS NULL)
  );
