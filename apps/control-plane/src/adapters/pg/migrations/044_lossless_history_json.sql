DO $$
DECLARE
  attempt integer;
BEGIN
  FOR attempt IN 1..120 LOOP
    BEGIN
      LOCK TABLE orbs, history_records IN ACCESS EXCLUSIVE MODE NOWAIT;
      IF attempt > 1 THEN
        RAISE LOG 'lifecycle: migration-lock-acquired name="044_lossless_history_json.sql" attempts=%', attempt;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt = 1 THEN
        RAISE LOG 'lifecycle: migration-lock-contended name="044_lossless_history_json.sql"';
      END IF;
      IF attempt = 120 THEN
        RAISE LOG 'lifecycle: migration-lock-exhausted name="044_lossless_history_json.sql" attempts=120 sqlstate=55P03';
        RAISE;
      END IF;
    END;
    PERFORM pg_sleep(0.25);
  END LOOP;
END $$;

ALTER TABLE history_records
  DROP CONSTRAINT history_records_record_check,
  DROP CONSTRAINT history_records_check,
  DROP CONSTRAINT history_records_check1,
  ALTER COLUMN record TYPE json USING record::json,
  ADD CONSTRAINT history_records_record_check CHECK (json_typeof(record) = 'object');

ALTER TABLE orbs
  DROP CONSTRAINT orbs_harness_session_header_check,
  DROP CONSTRAINT orbs_check1,
  ALTER COLUMN harness_session_header TYPE json USING harness_session_header::json,
  ADD CONSTRAINT orbs_harness_session_header_check CHECK (
    harness_session_header IS NULL OR json_typeof(harness_session_header) = 'object'
  );
