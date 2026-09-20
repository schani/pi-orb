LOCK TABLE users IN EXCLUSIVE MODE;

DO $$
DECLARE
  mappings jsonb := coalesce(nullif(current_setting('pi_orb.google_identity_mappings', true), ''), '[]')::jsonb;
  mapping jsonb;
BEGIN
  IF jsonb_typeof(mappings) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Google identity mappings must be an array';
  END IF;
  FOR mapping IN SELECT value FROM jsonb_array_elements(mappings) LOOP
    IF jsonb_typeof(mapping) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Google identity mapping';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(mapping)) <> 4
      OR NOT mapping ?& ARRAY['userId', 'oldIssuer', 'oldSubject', 'googleSubject']
      OR jsonb_typeof(mapping->'userId') <> 'string'
      OR jsonb_typeof(mapping->'oldIssuer') <> 'string'
      OR jsonb_typeof(mapping->'oldSubject') <> 'string'
      OR jsonb_typeof(mapping->'googleSubject') <> 'string'
      OR (mapping->>'userId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR mapping->>'oldIssuer' <> 'https://cloud.google.com/iap'
      OR mapping->>'oldSubject' !~ '[^[:space:]]'
      OR mapping->>'googleSubject' !~ '[^[:space:]]' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Google identity mapping';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = (mapping->>'userId')::uuid
      AND identity_issuer = mapping->>'oldIssuer' AND identity_subject = mapping->>'oldSubject') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Google identity mapping does not match existing user';
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE identity_issuer = 'https://accounts.google.com'
      AND identity_subject = mapping->>'googleSubject') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Google identity destination already exists';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(mappings) m GROUP BY (m->>'userId')::uuid HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(mappings) m GROUP BY m->>'googleSubject' HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(mappings) m GROUP BY m->>'oldIssuer', m->>'oldSubject' HAVING count(*) > 1) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'duplicate Google identity mapping';
  END IF;
  IF EXISTS (SELECT 1 FROM users u WHERE identity_issuer = 'https://cloud.google.com/iap'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(mappings) m WHERE (m->>'userId')::uuid = u.id)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Google identity mappings must cover every IAP user';
  END IF;
  UPDATE users u SET identity_issuer = 'https://accounts.google.com', identity_subject = m->>'googleSubject'
    FROM jsonb_array_elements(mappings) m WHERE u.id = (m->>'userId')::uuid;
END $$;
