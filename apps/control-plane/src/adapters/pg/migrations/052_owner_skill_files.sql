ALTER TABLE user_skills
  ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN source jsonb;
