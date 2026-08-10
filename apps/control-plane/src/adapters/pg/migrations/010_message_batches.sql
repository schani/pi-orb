ALTER TABLE orb_messages
  ADD COLUMN delivery_batch_id uuid;

CREATE INDEX orb_messages_batch_idx
  ON orb_messages (orb_id, delivery_batch_id)
  WHERE delivery_batch_id IS NOT NULL;
