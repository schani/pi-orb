ALTER TABLE projects
  ADD COLUMN instructions_content text NOT NULL DEFAULT ''
    CHECK (octet_length(instructions_content) <= 65536),
  ADD COLUMN instructions_revision bigint NOT NULL DEFAULT 0
    CHECK (instructions_revision >= 0 AND instructions_revision <= 9007199254740991);
