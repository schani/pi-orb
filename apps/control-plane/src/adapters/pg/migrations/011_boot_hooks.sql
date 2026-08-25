-- Boot hook failure of the current boot (docs/orb-setup-hook.md).
-- Written when the orb becomes running, from the runtime's health report: a boot whose
-- hooks all succeeded clears the previous boot's failure, so these always describe now.

ALTER TABLE orbs
  ADD COLUMN hook_failure_hook text,
  ADD COLUMN hook_failure_reason text,
  ADD COLUMN hook_failure_log text,
  ADD CONSTRAINT orbs_hook_failure_hook_valid CHECK (
    hook_failure_hook IS NULL OR hook_failure_hook IN ('setup', 'resume')
  ),
  ADD CONSTRAINT orbs_hook_failure_reason_valid CHECK (
    hook_failure_reason IS NULL
      OR hook_failure_reason IN ('failed', 'timeout', 'hook_not_executable')
  ),
  ADD CONSTRAINT orbs_hook_failure_complete CHECK (
    (hook_failure_hook IS NULL
      AND hook_failure_reason IS NULL
      AND hook_failure_log IS NULL)
    OR
    (hook_failure_hook IS NOT NULL
      AND hook_failure_reason IS NOT NULL
      AND hook_failure_log IS NOT NULL)
  );
