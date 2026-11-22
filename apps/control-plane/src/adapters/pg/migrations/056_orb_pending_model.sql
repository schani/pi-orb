ALTER TABLE orbs ADD COLUMN pending_model jsonb
  CHECK (pending_model IS NULL OR COALESCE((
    jsonb_typeof(pending_model) = 'object'
    AND jsonb_typeof(pending_model->'changeId') = 'string'
    AND length(pending_model->>'changeId') > 0
    AND pending_model - 'changeId' - 'model' = '{}'::jsonb
    AND jsonb_typeof(pending_model->'model') = 'object'
    AND jsonb_typeof(pending_model->'model'->'provider') = 'string'
    AND jsonb_typeof(pending_model->'model'->'id') = 'string'
    AND length(pending_model->'model'->>'provider') > 0
    AND length(pending_model->'model'->>'id') > 0
    AND (pending_model->'model') - 'provider' - 'id' = '{}'::jsonb
  ), false));
