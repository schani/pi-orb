# Projects and the control-plane API

## Project model

The first version is fully web-driven and does not require a local checkout or CLI.

A user registers a project in the web UI with:

- a project name;
- a public Git repository URL.

Starting an orb for the project performs a fresh clone into the orb filesystem. There is no local upload, dirty-state patch, sync-back workflow, clone cache, prepared snapshot, or other checkout optimization initially. The initial clone uses the repository's default branch; the resolved commit should be recorded for observability.

Repository URL validation is strict allowlisting, decided as follows:

- accepted input is either an `https` URL or Git's common scp-style spelling, `git@host:owner/repo.git` (decided 2026-08-10); scp-style input is normalized to canonical `https` before persistence and cloning rather than enabling SSH transport, and `GIT_ALLOW_PROTOCOL=https` is set for the clone so redirects cannot switch protocols;
- the hostname must be on a fixed allowlist, initially `github.com`, `gitlab.com`, `bitbucket.org`, and `codeberg.org`; extending the list is configuration, not a design change;
- HTTPS userinfo (credential-bearing URLs), explicit ports, and IP-literal hosts are rejected; the only accepted scp-style user is the conventional literal `git`;
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
PATCH /api/v1/projects/:projectId
DELETE /api/v1/projects/:projectId

GET  /api/v1/projects/:projectId/orbs
POST /api/v1/projects/:projectId/orbs
GET  /api/v1/orbs/:orbId
PATCH /api/v1/orbs/:orbId
POST /api/v1/orbs/:orbId/start
POST /api/v1/orbs/:orbId/stop
POST /api/v1/orbs/:orbId/archive
DELETE /api/v1/orbs/:orbId

GET  /api/v1/orbs/:orbId/history
PUT  /api/v1/orbs/:orbId/messages/:messageId
GET  /api/v1/orbs/:orbId/messages
WS   /api/v1/orbs/:orbId/live
WS   /api/v1/orbs/:orbId/terminal
```

`PATCH /api/v1/projects/:projectId` renames an active project. Project names are NFKC-normalized, trimmed, whitespace-normalized strings of 1–80 characters; renaming a deleting project conflicts. This narrow update keeps the repository URL immutable. Permanent project deletion is implemented as specified in `docs/project-deletion.md`: `DELETE /api/v1/projects/:projectId` atomically marks the project deleting and fans permanent deletion out to every child orb before removing the project row. The one orb update is the narrow naming endpoint described below. Permanent orb deletion is the asynchronous `DELETE` operation implemented in `docs/orb-deletion.md`: it removes both the authoritative filesystem and replica rather than retaining history. Read-only archival is implemented as specified in `docs/orb-archival.md`: it uses the same resource destruction but retains metadata and the sealed replica. OAuth is an internal prerequisite of orb creation/start, not a standalone frontend resource.

The browser generates project, orb, and queued-message UUIDs with the shared `generateUuid()` helper and includes them in create requests. The helper uses `crypto.randomUUID()` when available and falls back to `crypto.getRandomValues()` because plain-HTTP tailnet origins are not secure contexts and may not expose `randomUUID`; browser code must not call `crypto.randomUUID()` directly (`docs/postmortems/2026-08-10-send-anytime-plain-http-randomuuid.md`).

```ts
interface CreateProjectRequest {
  id: string;
  name: string;
  repositoryUrl: string;
}

interface UpdateProjectRequest {
  name: string;
}

interface CreateOrbRequest {
  id: string;
  name?: string;
}

interface UpdateOrbRequest {
  name: string;
}
```

This makes a retried create naturally idempotent without an idempotency table: the same ID and identical body returns the existing resource, while the same ID with different content returns `409 conflict`. Creating an orb also requests its initial start and returns it in `creating` state.

```ts
interface ProjectView {
  id: string;
  name: string;
  repositoryUrl: string;
  state: "active" | "deleting";
  deletionProgress?: {
    total: number;
    remaining: number;
    blocked: number;
  };
  createdAt: string;
  updatedAt: string;
}

interface OrbView {
  id: string;
  projectId: string;
  name: string | null;
  state: "creating" | "starting" | "running" | "stopping" | "stopped" | "failed" | "deleting"
    | "archiving" | "archived";
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

### Send-anytime messages (decided and implemented 2026-08-10)

All user messages use the idempotent message resource, including messages sent while the runtime is live. This is one ingress path, not an offline fallback beside WebSocket sending. The request body contains the same validated text/image block union as the current live `message` action and deliberately has no caller-selected steer/follow-up mode or `expectedHeadId`.

`PUT` returns `202` after the inbox row and lifecycle wake intent are durable. A client-generated UUID makes retries idempotent under the same identical-body/conflicting-body rule as project/orb creation. The response identifies `queued | delivering | delivered | failed`, may report `turn | steer` after runtime admission, and exposes only a sanitized failure. `failed` is written when the runtime rejects a delivery non-retryably (`docs/runtime-protocol.md`), and the sanitized reason is returned as `error`; retryable delivery failures never change the status, they are simply retried. `GET .../messages` restores outstanding and recent delivery state after reload; it is not conversation history. Actual user transcript records still enter `OrbHistoryView` only through runtime history replication.

The command is accepted for `creating`, `starting`, `running`, `stopping`, `stopped`, and recoverable `failed` orbs. It conflicts for `archiving`, `archived`, or `deleting` orbs. Acceptance requests ordinary startup when needed, but **acceptance itself never transitions the orb** (2026-08-11): the `202` means the message and its wake intent are durable, and the reconciler — nudged to run immediately by the same command — performs the one message-driven `stopped`/`failed` → `starting` transition a tick later (`docs/lifecycle.md`). A client that wants to display "starting" therefore reads the orb resource or its live updates rather than the message response. Explicit stop/message ordering and the durable wake rule are specified in `docs/lifecycle.md`. Payload limits must be enforceable before the runtime exists, so the control-plane limit is fixed at or below every enabled harness/runtime limit rather than learned only from `server.welcome`.

See `docs/runtime-protocol.md` for FIFO delivery, runtime-derived steering, durable identity, and why the live socket is not used as the queue.

### Orb names and first-message auto-naming (decided and implemented)

An orb has a nullable, non-unique display name. A user may supply it in `CreateOrbRequest` or set/replace it through `PATCH /api/v1/orbs/:orbId`; manual naming is allowed in every lifecycle state and is idempotent. Names are trimmed, whitespace-normalized Unicode strings of 1–80 characters. Clearing a name is not initially supported. No name-source field is needed: both user and generated names occupy the same column, generation may write only while `name IS NULL`, and any later user rename is an ordinary unconditional name update. `OrbView.name` is nullable so an unnamed orb can render as “untitled orb” plus a short ID.

Generation runs in the **control plane**, not in the orb. When the runtime accepts the first user `message` request, it reads bounded project context from its checkout and starts a bounded, non-blocking call to `POST /runtime/v1/orb-name-trigger`, authenticated by the existing per-incarnation orb bearer token. The body is `{ text: string, imageOnly: boolean, readme?: string }`, has a small fixed byte limit, and carries no orb ID because authentication already identifies the orb. A successful assignment, an already-named orb, or another worker holding the naming lease is an idempotent success; transient generation/storage failure is retryable. The endpoint fetches the project name and canonical repository URL, then its control-plane model adapter invokes the `openai-codex` catalog model `gpt-5.6-luna`. Keeping inference here centralizes the prompt/model policy, credential use, leases, retries, and conditional database write; the orb is only the source of checkout-local context. The request remains active until generation/assignment finishes rather than enqueueing fragile in-memory background work, but neither it nor Luna delays the agent turn.

The runtime includes a root README when available. It chooses deterministically from regular, non-symlink files whose basename matches `README` or `README.*` case-insensitively, rejects a resolved path outside the checkout, decodes UTF-8 text only, and truncates it to a fixed byte budget before sending. README lookup/read failure is non-fatal and simply omits the field. Project metadata, README text, and first-message text are all quoted as untrusted prompt data. Shell records do not trigger naming. For an image-only first message, the trigger sends an explicit image-only marker rather than copying image bytes into a second inference call.

On runtime boot, an orb with an existing first user message replays the same trigger from persisted session history and the current checkout README; the control-plane endpoint checks the name before claiming inference, so already-named orbs make this a cheap no-op. Replicated-history reconciliation is a final fallback and may generate from project metadata plus the first message when no runtime is reachable; in that case README is not available to the control plane.

The naming prompt treats project/message text as quoted untrusted data and asks for one short descriptive name. The shared `@pi-orb/luna` adapter package enforces no tools and minimal reasoning and omits `reasoning.summary` entirely: a real Luna request proved that the Codex endpoint rejects `"off"` even though the Pi option type accepts it (supported wire values are `auto | concise | detailed`); this policy is covered by `packages/luna/src/index.test.ts` and is reused by turn-notification summaries. The adapter validates and normalizes the result against the same name rules; malformed output is a retryable generation failure rather than a reason to alter the conversation or orb lifecycle state.

This stays out of the live proxy, which remains content-agnostic: the runtime is the authority that knows a message was accepted and can read the checkout, while replicated history is the durable fallback. Generation runs asynchronously relative to the agent operation and never delays or fails the user's turn. A durable lease/backoff on the orb row prevents the immediate trigger, fallback reconciler, and rollout-overlap workers from repeatedly paying for the same generation while allowing recovery after process death or transient model/storage failure. The final write is conditional on `name IS NULL`; therefore a user rename at any point, including while Luna is running, always wins. Failures are logged without message content and retried with capped exponential backoff; they do not populate the orb's lifecycle `lastError`.

The browser shows the name as the primary identity in project orb lists and the sticky orb header, keeps the short orb ID as secondary metadata, and offers inline rename. Existing orb polling makes an asynchronously generated name appear without a new push protocol.

Implementation: PostgreSQL migration `005_orb_names.sql` (also exercised by the local PGlite backend); protocol schemas in `packages/protocol/src/orb-naming.ts` and `control-plane-api.ts`; lease/race domain logic in `domain/orb-naming.ts`; naming adapter `adapters/pi-name-generator.ts` over the shared `packages/luna` inference adapter; runtime trigger and replicated-history fallback in `http/runtime-routes.ts`, `orb-runtime/src/pi/agent.ts`, and `domain/replication.ts`. The user-wins and concurrent-trigger schedules are covered by `orb-naming.dst.test.ts`; the full-slice E2E asserts the generated name.

Do not expose `host_ref`, model credentials, harness session ID, or internal replication fields in `OrbView`. `actionRequired` is synthesized from the current in-memory device flow and can contain only its public challenge; it is not stored in the orb row. `stateDetail` is synthesized the same way from in-memory reconciler state: while `stopping` it reports the history-drain blocker — for example a retrying database outage — so a long stop is explained rather than an unlabeled spinner, and new detail variants can be added later without schema changes. The dedicated history response exposes only the cursor/head needed for live handoff.

Status behavior:

- project creation returns `201`;
- project delete returns `202` with `state: "deleting"`, atomically prevents new child creation, and eventually makes the project and all child orb resources return `404` (`docs/project-deletion.md`);
- orb creation and start/stop requests return `202` with the current `OrbView`;
- before creating/starting the host, the backend resolves and refreshes Codex OAuth; if user interaction is required, the orb remains in `creating`/`starting` and the response returns the device-login challenge in `actionRequired`;
- the browser polls only the normal orb resource, not an auth resource; when login succeeds the backend resumes lifecycle work automatically;
- lifecycle endpoints are idempotent when already moving toward or in the requested state;
- delete returns `202` with `state: "deleting"`, conflicts with every other orb mutation once accepted, and eventually makes the orb and history endpoints return `404` (`docs/orb-deletion.md`);
- archive returns `202` with `state: "archiving"`; history stays readable, completion yields terminal `archived`, start is permanently rejected, and later delete remains available (`docs/orb-archival.md`);
- lifecycle work is asynchronous and recoverable from `orbs.state`; the browser polls `GET /api/v1/orbs/:orbId`;
- while an orb is `stopping`, the orb resource includes `stateDetail` so the requester sees drain progress and retryable blockers instead of an unexplained wait;
- a process restart finds `creating`, `starting`, `stopping`, and `deleting` rows and resumes reconciliation, including restarting a required OAuth flow or destructive cleanup, so no transient job is authoritative;
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
