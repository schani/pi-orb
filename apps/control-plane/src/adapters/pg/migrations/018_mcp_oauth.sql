-- OAuth state and sanitized edges only; credentials remain in the secret store.
CREATE TABLE mcp_oauth (
  connection_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url text NOT NULL,
  state jsonb NOT NULL
);
CREATE INDEX mcp_oauth_project ON mcp_oauth(project_id);
CREATE TABLE mcp_oauth_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  row_version bigint NOT NULL,
  generation bigint NOT NULL,
  edge text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_oauth_events_connection ON mcp_oauth_events(connection_id, id);

CREATE TABLE mcp_oauth_garbage (
  secret_version text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  failed boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL,
  generation bigint NOT NULL
);

-- Pointer retirement and cleanup ownership commit together, including catalog
-- removal and login/refresh replacement. Exact immutable versions are safe to
-- destroy repeatedly; a collector never enumerates and guesses a live grant.
CREATE FUNCTION queue_retired_mcp_oauth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version text;
BEGIN
  FOR version IN SELECT DISTINCT v FROM unnest(ARRAY[
    OLD.state->>'secretVersion', OLD.state->'attempt'->>'secretVersion'
  ]) AS v WHERE v IS NOT NULL LOOP
    IF version IS DISTINCT FROM NEW.state->>'secretVersion'
       AND version IS DISTINCT FROM NEW.state->'attempt'->>'secretVersion' THEN
      INSERT INTO mcp_oauth_garbage(secret_version,project_id,connection_id,row_version,generation)
      VALUES(version,OLD.project_id,OLD.connection_id,(OLD.state->>'rowVersion')::bigint,(OLD.state->>'generation')::bigint) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER retire_mcp_oauth_credentials AFTER UPDATE ON mcp_oauth
FOR EACH ROW EXECUTE FUNCTION queue_retired_mcp_oauth();
