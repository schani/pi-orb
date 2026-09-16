CREATE TABLE users (
  id uuid PRIMARY KEY,
  identity_issuer text NOT NULL,
  identity_subject text NOT NULL,
  email text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (identity_issuer, identity_subject)
);
