ALTER TABLE orbs ADD COLUMN resource_warnings jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(resource_warnings) = 'array' AND jsonb_array_length(resource_warnings) <= 5000);

ALTER TABLE orb_resource_events
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(warnings) = 'array' AND jsonb_array_length(warnings) <= 5000),
  ADD COLUMN error_message text CHECK (char_length(error_message) <= 1536);
