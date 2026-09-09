ALTER TABLE workspace_uploads ADD COLUMN batch_id uuid;
UPDATE workspace_uploads SET batch_id = id;
ALTER TABLE workspace_uploads ALTER COLUMN batch_id SET NOT NULL;
CREATE INDEX workspace_uploads_batch ON workspace_uploads (orb_id, batch_id);
