ALTER TABLE orbs ADD COLUMN initial_model jsonb
  CHECK (initial_model IS NULL OR COALESCE((
    jsonb_typeof(initial_model) = 'object'
    AND initial_model ?& ARRAY['provider', 'id']
    AND jsonb_typeof(initial_model->'provider') = 'string'
    AND jsonb_typeof(initial_model->'id') = 'string'
    AND length(initial_model->>'provider') > 0
    AND length(initial_model->>'id') > 0
    AND initial_model - 'provider' - 'id' = '{}'::jsonb
  ), false));
