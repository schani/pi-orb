-- Content-free ledger of platform-managed model calls (docs/model-usage.md). No foreign keys:
-- rows outlive orb archival, orb deletion and project deletion.
CREATE TABLE model_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL,          -- response completion
  owner_user_id text NOT NULL,      -- whose subscription paid
  orb_id uuid NOT NULL,
  use text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  outcome text NOT NULL,            -- AssistantMessage.stopReason
  input integer NOT NULL,           -- uncached prompt tokens
  output integer NOT NULL,          -- includes reasoning
  cache_read integer NOT NULL,
  cache_write integer NOT NULL,
  duration_ms integer
);
CREATE INDEX model_calls_at ON model_calls (at);
CREATE INDEX model_calls_orb_at ON model_calls (orb_id, at);
