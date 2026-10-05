CREATE TABLE activity_headlines (
  orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  record_id text NOT NULL,
  detail_key text NOT NULL,
  headline text NOT NULL,
  generated_at timestamptz NOT NULL,
  PRIMARY KEY (orb_id, session_id, record_id, detail_key),
  FOREIGN KEY (orb_id, record_id)
    REFERENCES history_records(orb_id, record_id) ON DELETE CASCADE
);

CREATE FUNCTION delete_activity_headlines_on_session_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM activity_headlines WHERE orb_id = OLD.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER activity_headlines_session_change
AFTER UPDATE OF harness_session_id ON orbs
FOR EACH ROW
WHEN (OLD.harness_session_id IS DISTINCT FROM NEW.harness_session_id)
EXECUTE FUNCTION delete_activity_headlines_on_session_change();
