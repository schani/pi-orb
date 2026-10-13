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
