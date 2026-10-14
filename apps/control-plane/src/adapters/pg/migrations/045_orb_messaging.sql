ALTER TABLE orb_messages DROP CONSTRAINT orb_messages_system_check;
ALTER TABLE orb_messages ADD CONSTRAINT orb_messages_system_check CHECK (
  system IS NULL OR COALESCE((
    jsonb_typeof(system) = 'object' AND (
      (
        system ?& ARRAY['kind', 'sleepUntil']
        AND system->>'kind' IN ('sleep_wake', 'sleep_expired')
        AND jsonb_typeof(system->'sleepUntil') = 'string'
        AND system - 'kind' - 'sleepUntil' = '{}'::jsonb
      ) OR (
        system ?& ARRAY['kind', 'senderOrbId']
        AND system->>'kind' = 'orb_message'
        AND jsonb_typeof(system->'senderOrbId') = 'string'
        AND system->>'senderOrbId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND system - 'kind' - 'senderOrbId' = '{}'::jsonb
      )
    )
  ), false)
);
