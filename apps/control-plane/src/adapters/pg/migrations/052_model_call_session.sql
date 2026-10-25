-- Pi provider session of each Durable call, naming subagent calls on the transcript timeline (docs/model-usage.md).
ALTER TABLE model_calls ADD COLUMN session_id text;
