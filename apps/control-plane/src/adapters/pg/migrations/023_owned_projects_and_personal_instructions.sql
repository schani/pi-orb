DO $$
DECLARE
  owner_id_text text := nullif(current_setting('pi_orb.original_user_id', true), '');
  owner_issuer text := nullif(current_setting('pi_orb.original_identity_issuer', true), '');
  owner_subject text := nullif(current_setting('pi_orb.original_identity_subject', true), '');
  needs_owner boolean;
  matching_user users%ROWTYPE;
BEGIN
  SELECT EXISTS (SELECT 1 FROM projects)
    OR EXISTS (
      SELECT 1 FROM personal_instructions
      WHERE content <> '' OR revision <> 0
    )
  INTO needs_owner;

  IF (owner_id_text IS NULL) <> (owner_issuer IS NULL)
    OR (owner_id_text IS NULL) <> (owner_subject IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'original owner mapping must be all-or-none';
  END IF;

  IF needs_owner AND owner_id_text IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'original owner mapping required for existing data';
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
  END IF;
END $$;

ALTER TABLE projects ADD COLUMN owner_user_id uuid REFERENCES users(id);
UPDATE projects
SET owner_user_id = nullif(current_setting('pi_orb.original_user_id', true), '')::uuid;
ALTER TABLE projects ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE projects DROP CONSTRAINT projects_name_key;
ALTER TABLE projects ADD CONSTRAINT projects_owner_user_id_name_key UNIQUE (owner_user_id, name);

ALTER TABLE personal_instructions ADD COLUMN user_id uuid REFERENCES users(id);
UPDATE personal_instructions
SET user_id = nullif(current_setting('pi_orb.original_user_id', true), '')::uuid;
DELETE FROM personal_instructions WHERE user_id IS NULL;
ALTER TABLE personal_instructions DROP CONSTRAINT personal_instructions_pkey;
ALTER TABLE personal_instructions DROP COLUMN singleton;
ALTER TABLE personal_instructions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE personal_instructions ADD PRIMARY KEY (user_id);
