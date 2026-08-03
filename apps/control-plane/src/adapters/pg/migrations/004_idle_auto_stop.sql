-- Idle auto-stop (DESIGN.md §3.4): last_busy_at is the restart-stable activity
-- timestamp (advisory, updated outside the state_version CAS); stop_reason
-- distinguishes an automatic idle stop from an explicit one in the UI.
ALTER TABLE orbs ADD COLUMN last_busy_at timestamptz;
ALTER TABLE orbs ADD COLUMN stop_reason text CHECK (stop_reason IN ('idle'));
