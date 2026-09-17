DO $$
DECLARE
  owner_id_text text := nullif(current_setting('pi_orb.original_user_id', true), '');
  owner_issuer text := nullif(current_setting('pi_orb.original_identity_issuer', true), '');
  owner_subject text := nullif(current_setting('pi_orb.original_identity_subject', true), '');
  needs_owner boolean;
  matching_user users%ROWTYPE;
BEGIN
  SELECT EXISTS (SELECT 1 FROM credential_pointers) INTO needs_owner;

  IF (owner_id_text IS NULL) <> (owner_issuer IS NULL)
    OR (owner_id_text IS NULL) <> (owner_subject IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'original owner mapping must be all-or-none';
  END IF;
  IF needs_owner AND owner_id_text IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'original owner mapping required for existing credential pointers';
  END IF;
  IF owner_id_text IS NOT NULL THEN
    SELECT * INTO matching_user FROM users
      WHERE id = owner_id_text::uuid
         OR (identity_issuer = owner_issuer AND identity_subject = owner_subject);
    IF FOUND AND NOT (
      matching_user.id = owner_id_text::uuid
      AND matching_user.identity_issuer = owner_issuer
      AND matching_user.identity_subject = owner_subject
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'original owner mapping conflicts with existing user';
    END IF;
    INSERT INTO users (id, identity_issuer, identity_subject, email, created_at, updated_at)
      VALUES (owner_id_text::uuid, owner_issuer, owner_subject, NULL, now(), now())
      ON CONFLICT (id) DO NOTHING;
    SELECT * INTO matching_user FROM users WHERE id = owner_id_text::uuid;
    IF NOT (
      matching_user.identity_issuer = owner_issuer
      AND matching_user.identity_subject = owner_subject
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'original owner mapping conflicts with existing user';
    END IF;
  END IF;
END $$;

ALTER TABLE credential_pointers ADD COLUMN user_id uuid REFERENCES users(id);
UPDATE credential_pointers
SET user_id = nullif(current_setting('pi_orb.original_user_id', true), '')::uuid;
ALTER TABLE credential_pointers ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE credential_pointers DROP CONSTRAINT credential_pointers_pkey;
ALTER TABLE credential_pointers ADD PRIMARY KEY (user_id, provider);
