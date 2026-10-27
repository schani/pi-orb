ALTER TABLE user_skills
  ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(files) = 'array'),
  ADD COLUMN source jsonb CHECK (source IS NULL OR jsonb_typeof(source) = 'object');
