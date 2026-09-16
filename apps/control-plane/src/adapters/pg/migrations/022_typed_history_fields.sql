-- Typed record fields for transcripts persisted before the Pi adapter derived
-- them (docs/pi-adapter.md). `overflow` is untouched and stays lossless.
-- Every statement derives exactly what `mapPiEntry` derives and nothing else: a
-- native value of the wrong JSON type is absent rather than coerced, so no row
-- can become schema-invalid and no shape can abort the migration.

-- Shell blocks.
UPDATE history_records SET record = record || jsonb_build_object(
  'shell', jsonb_build_object(
    'command', CASE
      WHEN jsonb_typeof(record->'overflow'->'native'->'message'->'command') = 'string'
      THEN record->'overflow'->'native'->'message'->>'command'
      ELSE ''
    END,
    'output', CASE
      WHEN jsonb_typeof(record->'overflow'->'native'->'message'->'output') = 'string'
      THEN record->'overflow'->'native'->'message'->>'output'
      ELSE ''
    END,
    'exitCode', CASE
      WHEN jsonb_typeof(record->'overflow'->'native'->'message'->'exitCode') = 'number'
      THEN record->'overflow'->'native'->'message'->'exitCode'
      ELSE 'null'::jsonb
    END,
    'cancelled',
      COALESCE(record->'overflow'->'native'->'message'->'cancelled' = 'true'::jsonb, false),
    'truncated',
      COALESCE(record->'overflow'->'native'->'message'->'truncated' = 'true'::jsonb, false),
    'excludeFromContext',
      COALESCE(
        record->'overflow'->'native'->'message'->'excludeFromContext' = 'true'::jsonb, false
      )
  )
)
WHERE record->>'type' = 'event'
  AND record->>'eventType' = 'pi.bash_execution'
  AND record->'shell' IS NULL
  AND jsonb_typeof(record->'overflow'->'native'->'message') = 'object';

-- Custom-message identity and visibility.
UPDATE history_records SET record = record || jsonb_build_object(
  'custom', jsonb_build_object(
    'customType', CASE
      WHEN jsonb_typeof(record->'overflow'->'native'->'customType') = 'string'
      THEN record->'overflow'->'native'->>'customType'
      ELSE ''
    END,
    'display', COALESCE(record->'overflow'->'native'->'display' = 'true'::jsonb, false)
  )
)
WHERE record->>'type' = 'event'
  AND record->>'eventType' = 'pi.custom_message'
  AND record->'custom' IS NULL
  AND jsonb_typeof(record->'overflow'->'native') = 'object';

-- Subagent receipts: the kind, the receipt's string details, and its duration.
UPDATE history_records SET record = record || jsonb_build_object(
  'subagent',
    jsonb_build_object('kind', CASE record->'overflow'->'native'->>'customType'
      WHEN 'subagent-notification' THEN 'notification'
      WHEN 'subagent-update' THEN 'update'
      ELSE 'workspace_notice'
    END)
    || COALESCE((
      SELECT jsonb_object_agg(key, value)
      FROM jsonb_each(CASE
        WHEN jsonb_typeof(record->'overflow'->'native'->'details') = 'object'
        THEN record->'overflow'->'native'->'details'
        ELSE '{}'::jsonb
      END)
      WHERE jsonb_typeof(value) = 'string'
        AND key IN ('id', 'description', 'status', 'message', 'notice', 'error', 'resultPreview')
    ), '{}'::jsonb)
    || CASE
      WHEN jsonb_typeof(record->'overflow'->'native'->'details'->'durationMs') = 'number'
      THEN jsonb_build_object('durationMs', record->'overflow'->'native'->'details'->'durationMs')
      ELSE '{}'::jsonb
    END
)
WHERE record->>'type' = 'event'
  AND record->>'eventType' = 'pi.custom_message'
  AND record->'subagent' IS NULL
  AND record->'overflow'->'native'->>'customType' IN (
    'subagent-notification', 'subagent-update', 'subagent-workspace-notice'
  );

-- Inbox identities of the send-anytime envelope: squashed batches, then the
-- single-id form that predates them.
UPDATE history_records SET record = record || jsonb_build_object(
  'inboxMessageIds', (
    SELECT jsonb_agg(id)
    FROM jsonb_array_elements(record->'overflow'->'native'->'details'->'messageIds') AS id
    WHERE jsonb_typeof(id) = 'string'
  )
)
WHERE record->>'type' = 'message'
  AND record->'inboxMessageIds' IS NULL
  AND record->'overflow'->'native'->>'customType' = 'pi-orb.user-message'
  AND jsonb_typeof(record->'overflow'->'native'->'details'->'messageIds') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(record->'overflow'->'native'->'details'->'messageIds') AS id
    WHERE jsonb_typeof(id) = 'string'
  );

UPDATE history_records SET record = record || jsonb_build_object(
  'inboxMessageIds', jsonb_build_array(record->'overflow'->'native'->'details'->'messageId')
)
WHERE record->>'type' = 'message'
  AND record->'inboxMessageIds' IS NULL
  AND record->'overflow'->'native'->>'customType' = 'pi-orb.user-message'
  AND jsonb_typeof(record->'overflow'->'native'->'details'->'messageIds') IS DISTINCT FROM 'array'
  AND jsonb_typeof(record->'overflow'->'native'->'details'->'messageId') = 'string';

-- Assistant failures and their diagnostic types.
UPDATE history_records SET record = record || jsonb_build_object(
  'failure', jsonb_build_object(
    'message', record->'overflow'->'native'->'message'->'errorMessage',
    'diagnostics', COALESCE((
      SELECT jsonb_agg(diagnostic->'type')
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(record->'overflow'->'native'->'message'->'diagnostics') = 'array'
        THEN record->'overflow'->'native'->'message'->'diagnostics'
        ELSE '[]'::jsonb
      END) AS diagnostic
      WHERE jsonb_typeof(diagnostic) = 'object'
        AND jsonb_typeof(diagnostic->'type') = 'string'
    ), '[]'::jsonb)
  )
)
WHERE record->>'type' = 'message'
  AND record->>'role' = 'assistant'
  AND record->>'finishReason' = 'error'
  AND record->'failure' IS NULL
  AND jsonb_typeof(record->'overflow'->'native'->'message'->'errorMessage') = 'string'
  -- Exactly ECMAScript's trim whitespace: WhiteSpace plus LineTerminator.
  AND btrim(
    record->'overflow'->'native'->'message'->>'errorMessage',
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  ) <> '';

-- Edit patches, onto the tool_result block that carries the result.
UPDATE history_records SET record = jsonb_set(record, '{content}', (
  SELECT jsonb_agg(CASE
    WHEN block->>'type' = 'tool_result'
    THEN block || jsonb_build_object(
      'patch', record->'overflow'->'native'->'message'->'details'->'patch'
    )
    ELSE block
  END)
  FROM jsonb_array_elements(record->'content') AS block
))
WHERE record->>'type' = 'message'
  AND jsonb_typeof(record->'content') = 'array'
  AND jsonb_array_length(record->'content') > 0
  AND jsonb_typeof(record->'overflow'->'native'->'message'->'details'->'patch') = 'string';
