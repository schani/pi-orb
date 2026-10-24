ALTER TABLE durable_pg_tasks
  DROP CONSTRAINT durable_pg_tasks_status_check,
  ADD CONSTRAINT durable_pg_tasks_status_check
    CHECK (status IN ('pending', 'running', 'sleeping', 'waiting', 'completing', 'terminal'));
