# Projects and the control-plane API

## Project model

The first version is fully web-driven and does not require a local checkout or CLI.

A user registers a project in the web UI with:

- a project name;
- a public Git repository URL.

Starting an orb for the project performs a fresh clone into the orb filesystem. There is no local upload, dirty-state patch, sync-back workflow, clone cache, prepared snapshot, or other checkout optimization initially. The initial clone uses the repository's default branch; the resolved commit should be recorded for observability.

Repository URL validation is strict allowlisting, decided as follows:

- the scheme must be exactly `https`, and `GIT_ALLOW_PROTOCOL=https` is set for the clone so redirects cannot switch protocols;
- the hostname must be on a fixed allowlist, initially `github.com`, `gitlab.com`, `bitbucket.org`, and `codeberg.org`; extending the list is configuration, not a design change;
- userinfo (credential-bearing URLs), explicit ports, and IP-literal hosts are rejected;
- the path must match the host's repository shape (for example `/{owner}/{repo}` with an optional `.git`);
- validation runs at project creation and is re-run by the runtime immediately before cloning, because the first slice's database is writable by anyone who can reach the control plane.

This forecloses local paths, `file://` URLs, credential leakage into the database and logs, and SSRF against internal networks or cloud metadata endpoints.

The environment is prescribed initially:

- Debian 12 (the runtime container image's base);
- Node.js 24;
- fixed orb runtime/container image on every provider;
- Spot `n2d-highmem-4` Container-Optimized OS VMs on GCE later, running that same container image;
- no required orb configuration for a simple TypeScript project.

Still open:

- whether users can choose a branch or revision after the first slice;
- whether and when to add an Orbfile;
- whether to adopt conventional setup/restart hooks before introducing a general configuration format;
- how prebuilt project environments or snapshots are keyed and invalidated later.

## Minimal control-plane API

The browser uses a small unauthenticated JSON API under `/api/v1`:

```text
GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/:projectId

GET  /api/v1/projects/:projectId/orbs
POST /api/v1/projects/:projectId/orbs
GET  /api/v1/orbs/:orbId
POST /api/v1/orbs/:orbId/start
POST /api/v1/orbs/:orbId/stop

GET  /api/v1/orbs/:orbId/history
WS   /api/v1/orbs/:orbId/live
```

There are no project/orb update/delete, credential, model-selection, admin, or generic host-operation endpoints in the first slice. OAuth is an internal prerequisite of orb creation/start, not a standalone frontend resource.

The browser generates project and orb UUIDs with `crypto.randomUUID()` and includes them in create requests:

```ts
interface CreateProjectRequest {
  id: string;
  name: string;
  repositoryUrl: string;
}

interface CreateOrbRequest {
  id: string;
}
```

This makes a retried create naturally idempotent without an idempotency table: the same ID and identical body returns the existing resource, while the same ID with different content returns `409 conflict`. Creating an orb also requests its initial start and returns it in `creating` state.

```ts
interface ProjectView {
  id: string;
  name: string;
  repositoryUrl: string;
  createdAt: string;
}

interface OrbView {
  id: string;
  projectId: string;
  state: "creating" | "starting" | "running" | "stopping" | "stopped" | "failed";
  stateVersion: number;
  checkoutCommit?: string;
  lastError?: string;
  stateDetail?: {
    type: "draining_history";
    retrying: boolean;
    message?: string;
  };
  stateChangedAt: string;
  actionRequired?: {
    type: "openai_codex_device_login";
    verificationUri: string;
    userCode: string;
    expiresAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface OrbHistoryView {
  orbId: string;
  session: HarnessSessionMetadata | null;
  cursor: string | null;
  headId: string | null;
  records: HistoryRecord[];
}
```

Do not expose `host_ref`, model credentials, harness session ID, or internal replication fields in `OrbView`. `actionRequired` is synthesized from the current in-memory device flow and can contain only its public challenge; it is not stored in the orb row. `stateDetail` is synthesized the same way from in-memory reconciler state: while `stopping` it reports the history-drain blocker — for example a retrying database outage — so a long stop is explained rather than an unlabeled spinner, and new detail variants can be added later without schema changes. The dedicated history response exposes only the cursor/head needed for live handoff.

Status behavior:

- project creation returns `201`;
- orb creation and start/stop requests return `202` with the current `OrbView`;
- before creating/starting the host, the backend resolves and refreshes Codex OAuth; if user interaction is required, the orb remains in `creating`/`starting` and the response returns the device-login challenge in `actionRequired`;
- the browser polls only the normal orb resource, not an auth resource; when login succeeds the backend resumes lifecycle work automatically;
- lifecycle endpoints are idempotent when already moving toward or in the requested state;
- lifecycle work is asynchronous and recoverable from `orbs.state`; the browser polls `GET /api/v1/orbs/:orbId`;
- while an orb is `stopping`, the orb resource includes `stateDetail` so the requester sees drain progress and retryable blockers instead of an unexplained wait;
- a process restart finds `creating`, `starting`, and `stopping` rows and resumes reconciliation, including restarting a required OAuth flow, so no job table is needed;
- history is returned as one complete database snapshot without pagination in the first slice;
- the live upgrade is accepted only for a running orb; otherwise it fails with `409`/`1013` as appropriate.

All list responses use `{ items: [...] }`. Errors use one shape:

```ts
interface ControlPlaneHttpError {
  error: {
    code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "internal";
    message: string;
    retryable: boolean;
  };
}
```

Fastify handlers validate TypeBox schemas, call Result-returning services, and fold each result into an explicit response. They never use exceptions for normal HTTP control flow.
