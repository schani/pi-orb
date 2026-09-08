-- Durable system-hosted files (docs/hosting.md).
CREATE TABLE hosting_operations (
  id text PRIMARY KEY,
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  runtime_token_hash text NOT NULL,
  incarnation bigint NOT NULL CHECK (incarnation >= 0),
  path text NOT NULL CHECK (path <> ''),
  size bigint NOT NULL CHECK (size >= 0),
  media_type text NOT NULL CHECK (media_type <> ''),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('reserved', 'uploading', 'published')),
  next_attempt bigint NOT NULL DEFAULT 0 CHECK (next_attempt >= 0),
  published_object_key text,
  published_object_generation text,
  published_created_at timestamptz,
  published_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (orb_id, request_id),
  CHECK (
    (state = 'published') =
    (published_object_key IS NOT NULL AND published_object_generation IS NOT NULL
      AND published_created_at IS NOT NULL AND published_updated_at IS NOT NULL)
  )
);

CREATE INDEX hosting_operations_orb_idx ON hosting_operations (orb_id);

CREATE TABLE hosting_attempts (
  id text PRIMARY KEY,
  operation_id text NOT NULL UNIQUE REFERENCES hosting_operations(id) ON DELETE RESTRICT,
  object_key text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch >= 1),
  state text NOT NULL CHECK (state IN ('beginning', 'session_ready', 'committed')),
  session_id text,
  committed_object_key text,
  committed_object_generation text,
  committed_size bigint CHECK (committed_size >= 0),
  committed_sha256 text CHECK (committed_sha256 ~ '^[a-f0-9]{64}$'),
  claim_owner text NOT NULL,
  claim_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state = 'beginning' AND session_id IS NULL AND committed_object_key IS NULL
      AND committed_object_generation IS NULL AND committed_size IS NULL
      AND committed_sha256 IS NULL)
    OR
    (state = 'session_ready' AND session_id IS NOT NULL AND committed_object_key IS NULL
      AND committed_object_generation IS NULL AND committed_size IS NULL
      AND committed_sha256 IS NULL)
    OR
    (state = 'committed' AND session_id IS NOT NULL AND committed_object_key IS NOT NULL
      AND committed_object_generation IS NOT NULL AND committed_size IS NOT NULL
      AND committed_sha256 IS NOT NULL)
  )
);

CREATE TABLE hosted_files (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE RESTRICT,
  path text NOT NULL,
  object_key text NOT NULL,
  object_generation text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  media_type text NOT NULL CHECK (media_type <> ''),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (orb_id, path)
);

CREATE TABLE hosting_cleanup_items (
  id text PRIMARY KEY,
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE RESTRICT,
  attempt_id text REFERENCES hosting_attempts(id) ON DELETE RESTRICT,
  operation_id text REFERENCES hosting_operations(id) ON DELETE RESTRICT,
  path text,
  session_id text,
  object_key text,
  object_generation text,
  claim_owner text,
  claim_until timestamptz,
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((object_key IS NULL) = (object_generation IS NULL)),
  CHECK (attempt_id IS NOT NULL OR session_id IS NOT NULL OR object_key IS NOT NULL)
);

CREATE INDEX hosting_cleanup_due_idx
  ON hosting_cleanup_items (claim_until, created_at);
CREATE INDEX hosting_cleanup_orb_idx ON hosting_cleanup_items (orb_id);

CREATE TABLE hosting_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'published', 'removed', 'cleanup_completed', 'cleanup_blocked'
  )),
  path text,
  operation_id text,
  cleanup_item_id text,
  object_key text,
  object_generation text,
  caller_incarnation bigint,
  message text,
  created_at timestamptz NOT NULL
);

CREATE INDEX hosting_events_orb_time_idx ON hosting_events (orb_id, created_at, id);
