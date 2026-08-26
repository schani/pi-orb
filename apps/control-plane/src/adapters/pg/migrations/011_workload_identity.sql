-- Orb workload identity (docs/workload-identity.md). last_mint_at is the
-- durable per-orb rate-limit floor, and it is advisory: it is written outside
-- the state_version CAS, so claiming a mint slot can never conflict with a
-- lifecycle transition. It never holds a token, a bearer, or a raw audience.
ALTER TABLE orbs
  ADD COLUMN last_mint_at timestamptz;

-- Public halves of the issuer's signing keys. A JWK is not a secret, so JWKS
-- is served straight from these rows; the private key exists only in the
-- secret store, addressed by the exact secret_version recorded here.
CREATE TABLE oidc_signing_keys (
  kid text PRIMARY KEY,
  secret_version text NOT NULL,
  public_jwk jsonb NOT NULL CHECK (jsonb_typeof(public_jwk) = 'object'),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'retired')),
  row_version bigint NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,

  CONSTRAINT oidc_signing_keys_timestamps_complete CHECK (
    (activated_at IS NOT NULL) = (state IN ('active', 'retired'))
    AND (retired_at IS NOT NULL) = (state = 'retired')
  )
);

-- Overlapping rotation publishes a pending key first and retires the old one
-- after the overlap window, but only ever one key signs.
CREATE UNIQUE INDEX oidc_signing_keys_one_active_idx
  ON oidc_signing_keys (state) WHERE state = 'active';
