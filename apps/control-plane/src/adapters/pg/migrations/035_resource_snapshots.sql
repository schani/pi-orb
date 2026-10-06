CREATE TABLE orb_resource_snapshots (
    orb_id uuid PRIMARY KEY REFERENCES orbs(id) ON DELETE CASCADE,
    commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
    manifest jsonb NOT NULL
);

CREATE TABLE orb_resource_files (
    orb_id uuid NOT NULL REFERENCES orb_resource_snapshots(orb_id) ON DELETE CASCADE,
    path text NOT NULL,
    bytes bytea NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (orb_id, path)
);
