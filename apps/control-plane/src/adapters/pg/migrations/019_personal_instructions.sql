CREATE TABLE personal_instructions (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  content text NOT NULL CHECK (octet_length(content) <= 65536),
  revision bigint NOT NULL CHECK (revision >= 0 AND revision <= 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO personal_instructions (content, revision) VALUES ('', 0);
