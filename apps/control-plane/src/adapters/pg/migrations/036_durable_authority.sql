CREATE TABLE durable_pg_owners (orb_id uuid PRIMARY KEY REFERENCES orbs(id) ON DELETE CASCADE, owner_id text NOT NULL, fence bigint NOT NULL, admission_version bigint NOT NULL, lease_until bigint NOT NULL, archived boolean NOT NULL DEFAULT false);

CREATE TABLE durable_pg_durable_metadata (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		singleton bigint NOT NULL CHECK (singleton = 1),
		next_id TEXT NOT NULL,
		next_seq bigint NOT NULL
	, PRIMARY KEY (orb_id, singleton));

CREATE TABLE durable_pg_record_ids (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		id bigint NOT NULL,
		record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
	, PRIMARY KEY (orb_id, id));

CREATE TABLE durable_pg_conversations (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		id bigint NOT NULL,
		owner_conversation_id bigint,
		owner_task_id bigint,
		record TEXT NOT NULL
	, PRIMARY KEY (orb_id, id));

CREATE TABLE durable_pg_entries (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		id bigint NOT NULL,
		conversation_id bigint NOT NULL,
		head bigint,
		commit_seq bigint NOT NULL,
		record TEXT NOT NULL
	, PRIMARY KEY (orb_id, id));

CREATE TABLE durable_pg_tasks (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		id bigint NOT NULL,
		conversation_id bigint NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
		abort_requested bigint NOT NULL CHECK (abort_requested IN (0, 1)),
		background bigint NOT NULL CHECK (background IN (0, 1)),
		record TEXT NOT NULL
	, PRIMARY KEY (orb_id, id));

CREATE TABLE durable_pg_submissions (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		id bigint NOT NULL,
		conversation_id bigint NOT NULL,
		request_id TEXT,
		status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
		record TEXT NOT NULL
	, PRIMARY KEY (orb_id, id));

CREATE TABLE durable_pg_documents (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		id bigint NOT NULL,
		kind TEXT NOT NULL,
		family bigint NOT NULL CHECK (family IN (0, 1)),
		key_value TEXT NOT NULL,
		scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
		owner_id bigint NOT NULL,
		created_at bigint NOT NULL,
		retired_at bigint,
		record TEXT NOT NULL
	, PRIMARY KEY (orb_id, id));

CREATE TABLE durable_pg_document_revisions (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE,
		document_id bigint NOT NULL,
		seq bigint NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
		version bigint NOT NULL,
		content TEXT NOT NULL,
		PRIMARY KEY (orb_id, document_id, seq)
	);

CREATE TABLE durable_pg_owner_events (orb_id uuid NOT NULL REFERENCES orbs(id) ON DELETE CASCADE, fence bigint NOT NULL, outcome text NOT NULL CHECK (outcome IN ('acquired','released','archived','draining')), recorded_at bigint NOT NULL, PRIMARY KEY(orb_id,fence,outcome));

CREATE INDEX durable_pg_entries_conversation ON durable_pg_entries(orb_id,conversation_id,id DESC);
CREATE INDEX durable_pg_tasks_status ON durable_pg_tasks(orb_id,status,id);
CREATE INDEX durable_pg_documents_address ON durable_pg_documents(orb_id,kind,scope_kind,owner_id,family,key_value,created_at DESC,retired_at);
CREATE INDEX durable_pg_submissions_request ON durable_pg_submissions(orb_id,conversation_id,request_id);
