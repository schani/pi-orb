# Control-plane API

Reference for the control plane's HTTP surface. Authentication, principals and ownership:
`docs/auth.md`. Runtime HTTP served by the orb itself: `docs/runtime-protocol.md`.

## Conventions

- Browser JSON API under `/api/v1`; runtime-facing routes under `/runtime/v1` (plus
  `/runtime/previews`, `/api/runtime/initial-checkout`, `/api/runtime/alert`), authenticated by the
  incarnation bearer (`docs/credentials.md`). Neither credential works on the other surface.
- Fastify handlers validate TypeBox schemas (`packages/protocol/src/`), call `Result`-returning
  services and fold each result explicitly. No exceptions for normal control flow.
- Lists are `{items: [...]}`.
- Missing resources return a resource-specific 404; browser HTML keeps the URL and links to the
  dashboard. Never a redirect.
- APIs never redirect into login; authentication failures are typed 401/403/503.

### Errors

```ts
interface ControlPlaneHttpError {
  error: {
    code: "invalid_request" | "unauthorized" | "not_found" | "conflict" | "unavailable" | "internal";
    message: string;
    retryable: boolean;
  };
}
```

`retryable` is a promise to the client. A store failure classified `invariant` (wrong SQL, an
unencodable parameter) answers 500 `internal`, `retryable: false`; only real outages answer 503
`unavailable`, `retryable: true` (`docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`).
The UI shows the message, so a deterministic bug is a visible failure, not an endless retry.

## Browser routes

| Route | Purpose | Contract |
| --- | --- | --- |
| `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Google login | `docs/auth.md` |
| `GET /auth/preview` | Preview login handoff | `docs/http-exposure.md` |
| `GET /api/v1/session` | Current principal | `docs/auth.md` |
| `GET /api/v1/system` | Deployment facts | below |
| `GET /api/v1/usage?boundaries=<JSON ms array>` | Owner model usage | `docs/model-usage.md` |
| `GET\|PUT /api/v1/personal-instructions` | Owner instructions | `docs/agent-context.md` |
| `GET\|PUT /api/v1/git-identity` | Owner Git `{name, email}` | `docs/agent-context.md` |
| `GET /api/v1/owner-secrets`, `PUT\|DELETE …/:name` | Owner secrets | `docs/agent-context.md` |
| `GET\|POST /api/v1/owner-skills`, `PUT\|DELETE …/:name` | Owner skills | `docs/agent-context.md` |
| `GET /api/v1/claude/auth`, `POST …/connect\|code\|cancel\|disconnect` | Claude connection | `docs/credentials.md` |
| `POST /api/v1/issuer/signing-keys/publish\|activate` | Key rotation (ops) | `docs/workload-identity.md` |
| `GET\|POST /api/v1/projects` | Owner's projects; create | below |
| `GET\|PATCH\|DELETE /api/v1/projects/:projectId` | Read, update, delete | below, `docs/teardown.md` |
| `GET\|PUT /api/v1/projects/:projectId/instructions` | Project instructions | `docs/agent-context.md` |
| `GET …/secrets`, `PUT\|DELETE …/secrets/:name` | Project secrets | `docs/credentials.md` |
| `GET\|PUT …/mcp`, `GET …/mcp/status`, `POST …/mcp/describe` | Project MCP | `docs/mcp.md` |
| `GET …/mcp/:id/oauth`, `POST …/oauth/connect\|disconnect` | MCP OAuth | `docs/mcp.md` |
| `GET /api/v1/mcp/oauth/callback`, `GET /mcp/oauth/failed` | MCP OAuth callback | `docs/mcp.md` |
| `GET\|POST /api/v1/projects/:projectId/orbs` | List; create orb | below |
| `GET\|PATCH\|DELETE /api/v1/orbs/:orbId` | Read, rename, delete | below, `docs/teardown.md` |
| `POST /api/v1/orbs/:orbId/start\|stop\|archive` | Lifecycle | below, `docs/lifecycle.md`, `docs/teardown.md` |
| `GET /api/v1/orbs/:orbId/history` | Display history | `docs/history.md` |
| `GET …/details/:recordId/:detailKey?sessionId=` | Committed detail | `docs/history.md` |
| `GET …/details/live/:operationId/:blockId?sessionId=` | Live detail | `docs/history.md` |
| `GET …/images/:recordId/:detailKey/:imageIndex?sessionId=` | Image bytes | `docs/history.md` |
| `POST …/headlines/:recordId/:detailKey?sessionId=` | Activity headline | `docs/activity-headlines.md` |
| `PUT /api/v1/orbs/:orbId/messages/:messageId` | Send message | `docs/inbox.md` |
| `POST /api/v1/orbs/:orbId/messages/poll` | Inbox state | `docs/inbox.md` |
| `POST /api/v1/orbs/:orbId/alerts/ack` | Acknowledge alert | `docs/orb-alerts.md` |
| `GET /api/v1/orbs/:orbId/hosted-files` | Hosted files | `docs/http-exposure.md` |
| `POST /api/v1/orbs/:orbId/uploads`, `…/uploads/:id/status\|chunk\|finish\|cancel` | Workspace uploads | `docs/workspace-uploads.md` |
| `WS /api/v1/orbs/:orbId/live` | Live agent socket | `docs/runtime-protocol.md` |
| `WS /api/v1/orbs/:orbId/terminal` | Terminal | `docs/terminal.md` |

Files-origin routes (`/s/…`, `/files/…`) and preview hosts: `docs/http-exposure.md`.

## Runtime routes

All require the caller's runtime bearer and derive the orb (and project, owner) from it; none
accepts a caller-selected identity.

| Route | Purpose | Contract |
| --- | --- | --- |
| `POST /runtime/v1/tokens/{model\|github}` | Brokered access tokens | `docs/credentials.md` |
| `POST /runtime/v1/claude-subscription` | Claude token | `docs/credentials.md` |
| `GET /runtime/v1/project-secrets` | Secret snapshot | `docs/credentials.md` |
| `POST /runtime/v1/id-token` | Workload identity JWT | `docs/workload-identity.md` |
| `GET /api/runtime/initial-checkout` | First checkout data | `docs/host-provider.md` |
| `POST /api/runtime/alert` | Raise alert | `docs/orb-alerts.md` |
| `GET /runtime/v1/project-instructions`, `/personal-instructions`, `/git-identity`, `/owner-skills` | Boot context | `docs/agent-context.md` |
| `GET /runtime/v1/mcp`, `POST /runtime/v1/mcp/:id/token` | MCP catalog, OAuth tokens | `docs/mcp.md` |
| `POST /runtime/v1/orb-name-trigger` | Auto-naming | below |
| `GET /runtime/v1/orbs`, `GET /runtime/v1/orbs/:orbId/transcript` | Inspection | below |
| `GET /runtime/v1/orb/self` | Own identity | below |
| `POST /runtime/v1/history/search` | History search | `docs/history.md` |
| `PUT /runtime/v1/orbs/:orbId/spawn` | Spawn orb | `docs/inbox.md` |
| `POST /runtime/v1/orb/send` | Peer message | `docs/inbox.md` |
| `POST /runtime/v1/orb/sleep`, `POST /runtime/v1/orb/boot-context` | Scheduled sleep | `docs/lifecycle.md` |
| `POST /runtime/v1/orb/archive`, `POST /runtime/v1/orb/delete` | Self-archive, self-delete | `docs/teardown.md` |
| `PUT\|DELETE /runtime/previews/:port`, `GET /runtime/previews` | Preview registration | `docs/http-exposure.md` |
| `POST\|GET\|DELETE /runtime/v1/hosting/files?path=` | Hosted files | `docs/http-exposure.md` |

Runtime mutations that accept work (spawn, send, sleep, archive, delete) return no-store 202 at
durable acceptance and use the error envelope above. A lost response means unknown acceptance.

Public: `/health`, `/.well-known/openid-configuration`, `/.well-known/jwks.json`
(`docs/workload-identity.md`).

## Projects

A signed-in user creates an owned project with a name and an optional repository URL. The project
and all children have one owner (`docs/auth.md`).

```ts
interface CreateProjectRequest { id: string; name: string; repositoryUrl?: string | null }
interface UpdateProjectRequest { name: string; repositoryUrl?: string | null }

interface ProjectView {
  id: string;
  name: string;
  repositoryUrl: string | null;
  state: "active" | "deleting";
  deletionProgress?: { total: number; remaining: number; blocked: number };
  createdAt: string;
  updatedAt: string;
}
```

- Names: NFKC-normalized, trimmed, whitespace-collapsed, 1–80 characters, unique per owner
  (typed 409 on create or rename).
- `repositoryUrl`: omitted, null and blank are equivalent and stored as null. No synthetic
  repository is created; the first checkout makes an empty directory without Git.
- `PATCH` updates name and repository in one SQL update fenced against deletion; invalid input
  returns 400 before either changes; a deleting project conflicts. A repository change affects only
  future fresh checkouts and not-yet-acquired central repository resources, never an existing
  workspace or remote.
- `DELETE` returns 202 `state: "deleting"`, is idempotent, and eventually 404s the project and
  every child (`docs/teardown.md`).

Repository URL allowlist (checked at create/update and again by the runtime before cloning):

- `https` URLs, or `git@host:owner/repo.git` normalized to `https` (no SSH transport; the clone
  sets `GIT_ALLOW_PROTOCOL=https`);
- GitHub shorthand `owner/repo` and `github.com/owner/repo` (optional `.git`, case-insensitive
  host), expanded to HTTPS GitHub, never a filesystem path;
- hosts `github.com`, `gitlab.com`, `bitbucket.org`, `codeberg.org` (extending is configuration);
- no userinfo, explicit ports or IP literals; the only scp user is `git`;
- the path must match the host's repository shape.

This forecloses local paths, `file://`, credentials in the database and SSRF. The first checkout
clones the default branch and records `checkoutCommit`.

## Orbs

```ts
interface CreateOrbRequest {
  id: string;                    // DNS-safe; becomes provider resource names
  harness?: "pi" | "claude";     // default "pi"
  name?: string;
  userTimeZone?: string;         // IANA
}
interface UpdateOrbRequest { name: string }

interface OrbView {
  id: string;
  projectId: string;
  harness: "pi" | "claude";
  name: string | null;
  state: "creating" | "starting" | "running" | "stopping" | "stopped" | "failed"
    | "deleting" | "archiving" | "archived";
  stateVersion: number;
  spawnedByOrb?: string;          // immutable spawn caller ID; on list and single GETs, kept after
                                  // caller archive/delete, may be omitted on mutations (docs/inbox.md)
  centralAgent?: boolean;
  filesBaseUrl?: string;          // derived, docs/http-exposure.md
  activity?: "idle" | "busy";
  previewActiveUntil?: string;    // docs/http-exposure.md
  checkoutCommit?: string;
  lastError?: string;
  resourceWarnings?: Array<{
    path: string;
    code: "invalid_yaml" | "invalid_utf8" | "invalid_metadata" | "duplicate_name";
  }>;
  stateDetail?:
    | { type: "discarding_failed_compute" | "replacing_stale_compute" | "draining_history"
          | "deleting_resources"; retrying: boolean; message?: string }
    | { type: "archiving_orb"; phase: "waiting_for_idle" | "sealing_history" | "deleting_resources";
        retrying: boolean; message?: string }
    | { type: "waiting_for_sleep"; sleepUntil: string; phase: "waiting_for_idle" | "stopping";
        message?: string }
    | { type: "waiting_for_runtime"; hostState: string | null;
        secondsSinceHostRunning: number | null; probeAttempts: number; lastProbeError?: string }
    | { type: "running_setup"; secondsRunning: number }
    | { type: "setup_failed"; hook: "setup" | "resume";
        reason: "failed" | "timeout" | "hook_not_executable"; logPath: string };
  sleepUntil?: string;            // docs/lifecycle.md
  stopReason?: "idle" | "sleep" | "manual";
  stateChangedAt: string;
  archivedAt?: string;
  unreadAlertId?: string;         // docs/orb-alerts.md
  actionRequired?:
    | { type: "openai_codex_device_login" | "github_device_login" | "claude_subscription_login";
        verificationUri: string; userCode: string; expiresAt: string }
    | { type: "owner_login_required"; provider: "openai-codex" | "github" | "claude" };
  createdAt: string;
  updatedAt: string;
}
```

View shaping:

- `actionRequired` comes from the reconciler's in-memory owner auth block. Only the owner sees the
  actionable variant; coworkers and ops see `owner_login_required`. No request header can
  impersonate the owner, and shaping never silently drops auth state on a secondary lookup failure.
- `stateDetail` combines in-memory reconciler state with sanitized durable status (drain blockers,
  persisted discard errors) and the runtime's latest health report (setup phase/failure,
  `docs/orb-setup-hook.md`). A control-plane restart cannot erase why cleanup is blocked.
- `activity` is the latest `idle | busy` this process observed in a history pull, for running orbs
  only; an advisory snapshot, not stored.
- `resourceWarnings` restore persisted snapshot warnings: repository skill path and allowlisted
  code only, never content or parser errors (`docs/pi.md`).
- Never exposed: `host_ref`, credentials, harness session ID, replication internals, workload
  identity status.

### Create and idempotency

The browser generates project, orb and message UUIDs with the shared `generateUuid()` helper
(`crypto.randomUUID()` when present, else `crypto.getRandomValues()`; plain-HTTP origins lack
`randomUUID`, `docs/postmortems/2026-08-10-send-anytime-plain-http-randomuuid.md`). Retry sends the
identical body.

The same ID, owner and normalized content returns the existing resource; a different owner or
content returns 409. No idempotency table. Specifically:

- Orb creation inherits the project owner, requests the initial start and returns 202 with the
  orb in `creating`.
- `harness` is immutable: a conflicting supplied value on retry is
  409; omission keeps the accepted one. Spawned orbs inherit the caller's harness. The durable
  `created` lifecycle edge records it.
- `userTimeZone` must be valid IANA (else 400). It is a per-orb creation snapshot
  (`orbs.user_time_zone`), not a preference; a different supplied zone on retry is 409, omission
  keeps it, concurrent creates keep the first.

### Status semantics

- Project create 201; orb create, start, stop 202 with the current `OrbView`.
- Lifecycle endpoints are idempotent when already moving toward or in the requested state.
- Before creating or starting a host, the backend resolves the owner's harness credential and
  GitHub; if a login is needed the orb stays `creating`/`starting` with `actionRequired`, and work
  resumes automatically after login. The browser polls only `GET /api/v1/orbs/:orbId`.
- Orb `DELETE` returns 202 `state: "deleting"` from every state and eventually 404s the orb and its
  history; archive returns 202 `state: "archiving"`. Both are idempotent; conflicts once accepted:
  `docs/teardown.md`. Start on an archived orb is a non-retryable 409.
- Messages are accepted for `creating` through recoverable `failed`, and conflict for `archiving`,
  `archived` and `deleting` (`docs/inbox.md`).
- Work is asynchronous and recoverable from `orbs.state`; after restart the reconciler resumes
  `creating`, `starting`, `stopping` and `deleting`, including OAuth flows and destructive cleanup.
- History is one complete projected snapshot, no pagination. Detail reads never start compute.
- The live upgrade is accepted only for a running orb; otherwise `409`/`1013`.

## Deployment facts

`GET /api/v1/system` returns `{hostProvider: "process" | "docker" | "gce", databaseKind:
"pglite" | "postgres", version, deploymentStatus?: "awaiting-activation" |
"activation-unavailable" | "superseded"}`. Values are resolved at boot; the route reads nothing per
request. No connection strings, project or zone names, images, secrets or fleet counts. Requires a
principal. The dashboard footer shows it.

## In-orb inspection

The `pi-orb` CLI reads siblings through runtime routes, never `/api/v1`.

- `GET /runtime/v1/orbs` returns one no-store snapshot: `currentOrbId` plus each of the calling orb
  owner's orbs (ID, nullable name, state, update time, project ID/name/repository URL), including
  stopped and archived. `pi-orb orbs [query]` filters locally (NFKC, case-insensitive substring).
- `GET /runtime/v1/orbs/:orbId/transcript` is company-wide: the exact consistent full replica
  snapshot plus compact identity, no-store. It never starts the target or contacts its runtime.
  Archived transcripts are complete; others have replication lag (`docs/history.md`). Missing →
  typed 404; deleting → typed 409. Harness system prompt and tool state are reduced to identity.
  The CLI omits `overflow.native` by default; `--json` returns the full response.
- `GET /runtime/v1/orb/self` (`pi-orb self [--json]`) returns no-store
  `{v:1, orb:{id,name,url,createdAt}, project:{id,name,repositoryUrl},
  spawnedByOrb:{id,url}|null, children:[{id,name,url}]}`. URLs use `PI_ORB_APP_ORIGIN`. Spawn
  provenance comes from `orb_spawns` and survives parent deletion. `children` lists existing direct
  spawn targets in ID order (archived/deleting until removed; deleted and grandchildren omitted).
  Native `orb_self` shares the service. The environment prompt mentions `pi-orb self [--json]`.

These reads write nothing and log no lifecycle events; typed CLI errors are the observability, and
transcript content never enters route logs.

## Orb names

An orb has a nullable, non-unique name: trimmed, whitespace-normalized, 1–80 characters. Users set
it at creation or with `PATCH /api/v1/orbs/:orbId` in any state (idempotent); clearing is not
supported. Unnamed orbs render as "untitled orb" plus a short ID.

Auto-naming runs in the control plane with Luna (`gpt-6-luna` via the owner's `openai-codex`
broker):

- When the runtime accepts the first user message it calls `POST /runtime/v1/orb-name-trigger`
  with `{text, imageOnly, readme?}` (small fixed limit, no orb ID). The README is the root
  `README`/`README.*` regular non-symlink file inside the checkout, UTF-8, truncated; failure omits
  it. Image-only messages send a marker, not bytes.
- The endpoint binds the broker to the project owner and supplies project name and repository URL;
  the owner UUID is not model input. Project, README and message text are quoted untrusted data.
  The shared `@pi-orb/luna` adapter uses no tools, minimal reasoning and omits
  `reasoning.summary` (the endpoint rejects `"off"`). Output is validated against the name rules;
  malformed output is a retryable failure.
- `orbs.auto_name_lease_until`, `auto_name_attempts` and `auto_name_next_attempt_at` are a durable
  lease and capped exponential backoff (no job table, no DB lock across inference) that stop duplicate generation across
  the trigger, the replicated-history fallback reconciler and overlapping releases. The write is
  conditional on `name IS NULL`, so a user rename always wins. Failures log without content and
  never set `lastError`. Success, already-named and lease-held are idempotent successes.
- Pi replays the trigger at boot from its first message; Claude triggers on accepted user messages
  without boot replay. The history fallback has the first message but no README.
- Claude orbs use Luna too and never gate startup on it. An absent owner Codex pointer returns
  `skipped`, releases the lease with backoff and logs `auto-name-skipped
  reason=codex_not_connected` on the first attempt only; other failures stay errors.

Code: `domain/orb-naming.ts` (DST `orb-naming.dst.test.ts`), `adapters/pi-name-generator.ts`,
`packages/luna`, `packages/protocol/src/orb-naming.ts`. Names appear through ordinary orb polling.
