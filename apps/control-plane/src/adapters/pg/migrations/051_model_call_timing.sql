-- Pi transcript timeline join and phases (docs/model-usage.md); NULL for Claude, unstreamed and older calls.
ALTER TABLE model_calls
  ADD COLUMN response_id text,
  ADD COLUMN ttft_ms integer,
  ADD COLUMN thinking_ms integer;
