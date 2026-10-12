CREATE TABLE git_identities (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  name text NOT NULL,
  email text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
