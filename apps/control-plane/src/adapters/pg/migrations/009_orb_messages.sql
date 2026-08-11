CREATE TABLE orb_messages (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'array'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
  delivery text CHECK (delivery IS NULL OR delivery IN ('turn', 'steer')),
  operation_id text,
  delivery_batch_id uuid,
  auto_start boolean NOT NULL DEFAULT false,
  -- Orb state_version against which a message-driven wake was admitted.
  -- See docs/lifecycle.md: stopped wakes for any intent; failed only for a
  -- wake naming its current version, so each new send retries failure once.
  wake_state_version bigint,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (orb_id, message_id),
  UNIQUE (orb_id, ordinal)
);

CREATE INDEX orb_messages_pending_idx
  ON orb_messages (orb_id, ordinal)
  WHERE status IN ('queued', 'delivering');

CREATE INDEX orb_messages_batch_idx
  ON orb_messages (orb_id, delivery_batch_id)
  WHERE delivery_batch_id IS NOT NULL;
