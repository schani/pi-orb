-- Typed record fields for transcripts persisted before the Pi adapter derived
-- them (docs/pi-adapter.md). `overflow` is untouched and stays lossless.

-- Shell blocks.
UPDATE history_records SET record = record || jsonb_build_object(
  'shell', jsonb_build_object(
    'command', COALESCE(record->'overflow'->'native'->'message'->>'command', ''),
    'output', COALESCE(record->'overflow'->'native'->'message'->>'output', ''),
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
    'customType', COALESCE(record->'overflow'->'native'->>'customType', ''),
    'display', COALESCE(record->'overflow'->'native'->'display' = 'true'::jsonb, false)
  )
)
WHERE record->>'type' = 'event'
  AND record->>'eventType' = 'pi.custom_message'
  AND record->'custom' IS NULL
  AND jsonb_typeof(record->'overflow'->'native') = 'object';

-- Subagent receipts.
UPDATE history_records SET record = record || jsonb_build_object(
  'subagent', jsonb_strip_nulls(jsonb_build_object(
    'kind', CASE record->'overflow'->'native'->>'customType'
      WHEN 'subagent-notification' THEN 'notification'
      WHEN 'subagent-update' THEN 'update'
      ELSE 'workspace_notice'
    END,
    'id', record->'overflow'->'native'->'details'->'id',
    'description', record->'overflow'->'native'->'details'->'description',
    'status', record->'overflow'->'native'->'details'->'status',
    'message', record->'overflow'->'native'->'details'->'message',
    'notice', record->'overflow'->'native'->'details'->'notice',
    'error', record->'overflow'->'native'->'details'->'error',
    'resultPreview', record->'overflow'->'native'->'details'->'resultPreview',
    'durationMs', CASE
      WHEN jsonb_typeof(record->'overflow'->'native'->'details'->'durationMs') = 'number'
      THEN record->'overflow'->'native'->'details'->'durationMs'
      ELSE NULL
    END
  ))
)
WHERE record->>'type' = 'event'
  AND record->'subagent' IS NULL
  AND record->'overflow'->'native'->>'customType' IN (
    'subagent-notification', 'subagent-update', 'subagent-workspace-notice'
  );

-- Inbox identities of the send-anytime envelope: squashed batches, then the
-- single-id form that predates them.
UPDATE history_records SET record = record || jsonb_build_object(
  'inboxMessageIds', COALESCE((
    SELECT jsonb_agg(id)
    FROM jsonb_array_elements(record->'overflow'->'native'->'details'->'messageIds') AS id
    WHERE jsonb_typeof(id) = 'string'
  ), '[]'::jsonb)
)
WHERE record->>'type' = 'message'
  AND record->'inboxMessageIds' IS NULL
  AND record->'overflow'->'native'->>'customType' = 'pi-orb.user-message'
  AND jsonb_typeof(record->'overflow'->'native'->'details'->'messageIds') = 'array';

UPDATE history_records SET record = record || jsonb_build_object(
  'inboxMessageIds', jsonb_build_array(record->'overflow'->'native'->'details'->'messageId')
)
WHERE record->>'type' = 'message'
  AND record->'inboxMessageIds' IS NULL
  AND record->'overflow'->'native'->>'customType' = 'pi-orb.user-message'
  AND jsonb_typeof(record->'overflow'->'native'->'details'->'messageId') = 'string';

-- Assistant failures and their diagnostic types.
UPDATE history_records SET record = record || jsonb_build_object(
  'failure', jsonb_build_object(
    'message', record->'overflow'->'native'->'message'->'errorMessage',
    'diagnostics', COALESCE((
      SELECT jsonb_agg(diagnostic->'type')
      FROM jsonb_array_elements(record->'overflow'->'native'->'message'->'diagnostics')
        AS diagnostic
      WHERE jsonb_typeof(diagnostic) = 'object'
        AND jsonb_typeof(diagnostic->'type') = 'string'
    ), '[]'::jsonb)
  )
)
WHERE record->>'type' = 'message'
  AND record->>'role' = 'assistant'
  AND record->>'finishReason' = 'error'
  AND record->'failure' IS NULL
  AND btrim(COALESCE(record->'overflow'->'native'->'message'->>'errorMessage', '')) <> '';

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
  AND jsonb_typeof(record->'overflow'->'native'->'message'->'details'->'patch') = 'string';
