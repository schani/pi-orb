-- JSON accessors decode even unselected strings. Sanitize escape units before accessing fields;
-- paired backslashes and valid surrogate pairs must precede single-escape alternatives.
CREATE OR REPLACE FUNCTION history_search_safe_json(source json) RETURNS json
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT string_agg(CASE WHEN part[1] ~ $bad$^\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})$$bad$
    THEN $space$\u0020$space$ ELSE part[1] END, '' ORDER BY ordinal)::json
  FROM regexp_matches(source::text,
    $units$\\(?:u[dD][89aAbB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)|[^\\]+$units$, 'g')
    WITH ORDINALITY AS matches(part, ordinal)
$fn$;

CREATE OR REPLACE FUNCTION history_search_tokens(input text) RETURNS text[]
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT coalesce(array_agg(part[1]), ARRAY[]::text[])
  FROM regexp_matches(lower(normalize(input, NFKC) COLLATE "C.utf8"), '[[:alnum:]]+', 'g') AS matched(part)
$fn$;

-- Only called with already-sanitized public tool arguments. Bound queued nodes, depth and output.
CREATE OR REPLACE FUNCTION history_search_arguments(source json) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
DECLARE
  pending json[] := ARRAY[source];
  depths integer[] := ARRAY[0];
  node json;
  depth integer;
  remaining integer := 2000;
  slots integer;
  child record;
  output text := '';
  piece text;
BEGIN
  WHILE cardinality(pending) > 0 AND remaining > 0 AND length(output) < 2000 LOOP
    node := pending[1]; depth := depths[1];
    pending := pending[2:]; depths := depths[2:]; remaining := remaining - 1;
    IF depth > 20 THEN CONTINUE; END IF;
    slots := greatest(remaining - cardinality(pending), 0);
    IF json_typeof(node) = 'object' THEN
      FOR child IN SELECT key, value FROM json_each(node) LIMIT slots / 2 LOOP
        pending := pending || ARRAY[to_json(child.key), child.value];
        depths := depths || ARRAY[depth + 1, depth + 1];
      END LOOP;
    ELSIF json_typeof(node) = 'array' THEN
      FOR child IN SELECT value FROM json_array_elements(node) LIMIT slots LOOP
        pending := array_append(pending, child.value);
        depths := array_append(depths, depth + 1);
      END LOOP;
    ELSE
      piece := CASE WHEN json_typeof(node) = 'string' THEN node #>> '{}' ELSE node::text END;
      output := left(concat_ws(E'\n', nullif(output, ''), piece), 2000);
    END IF;
  END LOOP;
  RETURN output;
END
$fn$;

-- Mirrors public display/detail selection, never native payload text or private child history.
CREATE OR REPLACE FUNCTION history_search_public_text(source json) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path FROM CURRENT AS $fn$
DECLARE
  r json := history_search_safe_json(source);
  native json;
  blocks json;
  block json;
  leaf json;
  args json;
  notice json;
  parts text[] := ARRAY[]::text[];
  piece text;
  field text;
  delivery boolean;
  whitespace CONSTANT text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF r ->> 'type' = 'message' AND r ->> 'role' IN ('system', 'developer') THEN RETURN ''; END IF;
  IF r ->> 'type' = 'event' AND r ->> 'eventType' IN ('claude.auth', 'claude.task_notification') THEN RETURN ''; END IF;
  IF r ->> 'type' = 'message' AND r ->> 'role' = 'user' AND r -> 'inboxMessageIds' IS NULL
     AND r #>> '{overflow,native,type}' = 'user' THEN
    native := r #> '{overflow,native}';
    IF native #>> '{message,role}' = 'user' AND json_typeof(native #> '{message,content}') = 'string'
       AND native #>> '{message,content}' ~ '^<local-command-stdout>.*</local-command-stdout>$' THEN RETURN ''; END IF;
  END IF;
  delivery := r ->> 'type' = 'message' AND r ->> 'role' = 'user' AND r -> 'inboxMessageIds' IS NULL
    AND NOT EXISTS (SELECT 1 FROM json_array_elements(r -> 'content') b WHERE b ->> 'type' = 'tool_result');
  IF json_typeof(native -> 'isMeta') = 'boolean' AND native ->> 'isMeta' = 'true' AND
     (NOT coalesce(delivery, false) OR native #>> '{origin,kind}' IS DISTINCT FROM 'task-notification'
       OR (native #> '{origin,subkind}' IS NOT NULL AND
         coalesce(native #>> '{origin,subkind}' NOT IN ('scheduled-trigger', 'peer-send-message', 'session-inbox'), true))) THEN RETURN ''; END IF;

  blocks := CASE
    WHEN r ->> 'type' = 'compaction' THEN r -> 'summary'
    WHEN r ->> 'type' = 'message' THEN r -> 'content'
    WHEN r ->> 'type' = 'event' AND r -> 'subagent' IS NULL AND
      ((json_typeof(r #> '{custom,display}') = 'boolean' AND r #>> '{custom,display}' = 'true') OR r ->> 'eventType' IN ('agent.settings_fallback', 'agent.compaction', 'orb.message'))
      THEN r -> 'content'
    ELSE '[]'::json END;
  FOR block IN SELECT value FROM json_array_elements(blocks) LOOP
    piece := '';
    IF block ->> 'type' = 'text' AND json_typeof(block -> 'text') = 'string' THEN
      piece := block ->> 'text';
    ELSIF r ->> 'type' <> 'compaction' AND NOT coalesce(delivery, false) AND block ->> 'type' = 'tool_call' THEN
      args := block -> 'arguments';
      IF block ->> 'name' = 'bash' THEN
        args := CASE WHEN json_typeof(args -> 'command') = 'string'
          THEN json_build_object('command', args ->> 'command') ELSE '{}'::json END;
      END IF;
      piece := left(concat_ws(E'\n', block ->> 'name', history_search_arguments(args)), 2000);
    ELSIF r ->> 'type' <> 'compaction' AND NOT coalesce(delivery, false) AND block ->> 'type' = 'tool_result' THEN
      FOR leaf IN SELECT value FROM json_array_elements(block -> 'content') LOOP
        IF leaf ->> 'type' = 'text' AND json_typeof(leaf -> 'text') = 'string' THEN
          piece := left(concat_ws(E'\n', nullif(piece, ''), leaf ->> 'text'), 2000);
          EXIT WHEN length(piece) >= 2000;
        END IF;
      END LOOP;
    END IF;
    IF piece <> '' THEN parts := array_append(parts, piece); END IF;
  END LOOP;
  IF r ->> 'type' = 'message' AND NOT coalesce(delivery, false) AND json_typeof(r #> '{failure,message}') = 'string' THEN
    parts := array_append(parts, r #>> '{failure,message}');
  ELSIF r ->> 'type' = 'event' THEN
    IF json_typeof(r #> '{alert,message}') = 'string' THEN parts := array_append(parts, r #>> '{alert,message}'); END IF;
    notice := r -> 'subagent';
    FOREACH field IN ARRAY ARRAY['description', 'status'] LOOP
      IF json_typeof(notice -> field) = 'string' THEN
        piece := notice ->> field;
        IF octet_length(piece) > 1024 THEN
          piece := left(piece, 1021);
          WHILE octet_length(piece) > 1021 LOOP piece := left(piece, length(piece) - 1); END LOOP;
          piece := piece || '…';
        END IF;
        IF piece <> '' THEN parts := array_append(parts, piece); END IF;
      END IF;
    END LOOP;
    field := CASE
      WHEN notice ->> 'kind' = 'notification' AND notice -> 'status' IS NULL AND notice -> 'error' IS NULL AND notice -> 'resultPreview' IS NULL THEN 'message'
      WHEN notice ->> 'kind' = 'update' THEN 'message'
      WHEN notice ->> 'kind' = 'workspace_notice' THEN 'notice'
      WHEN nullif(btrim(notice ->> 'error', whitespace), '') IS NOT NULL THEN 'error'
      ELSE 'resultPreview' END;
    IF json_typeof(notice -> field) = 'string' AND btrim(notice ->> field, whitespace) <> '' THEN
      parts := array_append(parts, notice ->> field);
    END IF;
  END IF;
  RETURN array_to_string(parts, E'\n');
END
$fn$;

-- Fixed-size candidate keys avoid GIN's per-key size limit. Ranking rechecks full tokens.
CREATE OR REPLACE FUNCTION history_search_keys(source json) RETURNS text[]
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE SET search_path FROM CURRENT AS $fn$
  SELECT coalesce(array_agg(DISTINCT md5(term)), ARRAY[]::text[])
  FROM unnest(history_search_tokens(history_search_public_text(source))) AS terms(term)
$fn$;

CREATE INDEX history_records_search_idx ON history_records USING gin(history_search_keys(record));
