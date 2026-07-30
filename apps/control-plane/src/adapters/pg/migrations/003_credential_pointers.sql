-- Credential pointer for the broker (DESIGN.md §15.1). Holds no secret
-- material: the credential itself lives in the secret store, addressed by
-- (provider, secret_version). Timestamps are wall-clock milliseconds to
-- match the domain type exactly.
CREATE TABLE credential_pointers (
  provider text PRIMARY KEY,
  row_version integer NOT NULL,
  generation integer NOT NULL,
  secret_version text,
  refresh_lease_until bigint NOT NULL DEFAULT 0,
  last_refresh_at bigint NOT NULL DEFAULT 0
);
