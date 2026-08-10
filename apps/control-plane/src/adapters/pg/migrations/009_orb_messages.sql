CREATE TABLE orb_messages (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'array'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'delivering', 'delivered', 'failed')),
  delivery text CHECK (delivery IS NULL OR delivery IN ('turn', 'steer')),
  operation_id text,
  auto_start boolean NOT NULL DEFAULT false,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (orb_id, message_id),
  UNIQUE (orb_id, ordinal)
);

CREATE INDEX orb_messages_pending_idx
  ON orb_messages (orb_id, ordinal)
  WHERE status IN ('queued', 'delivering');
