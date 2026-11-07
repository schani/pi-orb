# Application authentication and ownership

One Cloud Run application (`pi-orb-issuer`, `docs/deployment.md`) authenticates every request
itself. Users are trusted coworkers at one company. Each owns projects, credentials and personal
settings; direct access to other coworkers' resources is allowed. There is no hostile-tenant
isolation, quota, billing or collaboration feature.

## Principals and surfaces

Every protected request resolves exactly one principal before any handler runs:

```ts
type Principal =
  | { kind: "user"; user: { id: string; email: string | null } }
  | { kind: "ops"; id: string };
```

| Surface | Credential |
| --- | --- |
| Browser API and WebSockets (app origin) | Sealed app session cookie |
| Tooling on the ordinary API | Google machine ID token → `ops` principal |
| Runtime routes | Per-incarnation runtime bearer (`docs/credentials.md`) |
| Files and preview hosts | Their own host-only sessions, or orb id-tokens (`docs/http-exposure.md`) |
| Login, static shell, minimal `/health`, discovery/JWKS | Public allowlist |

Everything else is protected by default. Credentials never cross surfaces. An explicit but invalid
`Authorization` header never falls back to a cookie. Spoofed IAP or forwarding headers grant
nothing. Runtime bearers authorize only runtime routes, never `/api/v1/*`.

Composition selects the auth service. HTTP guards map typed results; provider and store adapters
contain third-party exceptions. Browser handlers never call identity storage or Google
verification directly. Source: `apps/control-plane/src/{identity-composition.ts,
domain/application-auth.ts, adapters/google-application-auth.ts, adapters/sealed-auth-cookies.ts,
http/auth-routes.ts, http/browser-identity.ts, http/hosting-access.ts}`.

## Users

`users` holds a stable UUID, a unique verified `(identity_issuer, identity_subject)` and a nullable
display email. Google login maps `https://accounts.google.com` + Google subject to the UUID. Email
is presentation only, never identity or linking authority. Issuer and subject never appear in
browser responses. Concurrent logins of one identity resolve to one UUID.

## Auth modes

`PI_ORB_AUTH_MODE` is required:

- `local`: a fixed trusted developer identity (`pi-orb:local` / `developer`). Refused when
  `K_SERVICE` is set (Cloud Run). Suitable only on a trusted machine and network. Global Origin
  protection stays on because the resolver grants ambient authority.
- `google`: requires `PI_ORB_GOOGLE_CLIENT_ID`, `PI_ORB_GOOGLE_CLIENT_SECRET`,
  `PI_ORB_COOKIE_SECRET` (≥ 32 characters), `PI_ORB_MACHINE_SUBJECT`, and exact HTTPS
  `PI_ORB_APP_ORIGIN` and `PI_ORB_HOSTING_ORIGIN` with distinct hostnames.

Tests inject explicit users.

## Google login

`openid-client` runs the authorization-code flow with PKCE, state and nonce. Admission requires the
Google issuer, exact client audience, expiry, a verified email and Workspace `hd=heyglide.com` in
the signed token. The outbound request carries no `hd` hint
(`docs/postmortems/2026-10-23-google-signed-out-login-500.md`).

- `GET /auth/login?returnTo=<local-path>` seals a ten-minute login transaction (state, nonce,
  verifier, validated local return path, callback origin) into `__Host-pi-orb-login`. One pending
  login per cookie jar; a new one replaces it. No login table, worker or resumable callback.
- `GET /auth/callback` (registered on both app and files origins) requires that cookie, validates state, nonce, PKCE and the exact
  destination, then resolves the user and issues the session. Google returns by cross-site GET, so
  this callback is a narrow exception to Origin checks.
- Google's single-use code prevents replay. Concurrent callbacks for one code may both try; at most
  one succeeds, and a losing callback never clears an issued session.
- An uncertain code exchange, identity commit or lost cookie response means a fresh login. No code
  retry or token recovery. Google `server_error`, `temporarily_unavailable` and `invalid_client`
  are typed unavailable, never retried automatically.
- Only explicit login and top-level unauthenticated navigation start login. APIs, HEAD and asset
  requests get typed 401/403/503 (500 for invariants), never redirects. URLs, including hashes,
  survive the round trip; recoverable drafts are retained.

## Sessions

`__Host-pi-orb-session` is an `@hapi/iron`-sealed cookie containing user UUID, nullable email,
origin, purpose and a fixed expiry seven days after login. Cookie Max-Age matches. All auth cookies
are `__Host-`, Secure, HttpOnly, SameSite=Lax, Path=/. Authenticity, purpose, origin and expiry are
checked on every request and WebSocket upgrade, using the injected service clock. The sealing key is
a restart-stable Secret Manager secret, purpose-separated between login and session cookies and
never a workload signing key. The Google client secret also comes from Secret Manager.

There is no session table, request-time identity lookup, sliding refresh or revocation version.
Rationale: the user chose stateless cookies over database sessions, accepting the logout limitation
below. Seven days (rather than shorter) reduces frequent logouts.

**Logout limitation.** `POST /auth/logout` (exact app Origin) clears the browser's cookie and closes
the initiating tab's sockets and principal-bound UI state. It cannot revoke a copied cookie: that
cookie authenticates new requests until expiry. Other open sockets continue until disconnect or
expiry; both proxy legs close at expiry. Replacing the sealing key and retiring old-key processes
invalidates every cookie at once. Expiry closes live sockets with 1008.

`GET /api/v1/session` returns `{status: "ok", principal}` with `Cache-Control: no-store`; cookie
sessions add `logoutAvailable: true`.

## Origin checks (CSRF)

Cookie-authenticated unsafe methods and browser WebSocket upgrades require the exact configured
Origin; missing, `null` and foreign origins fail. A supplied foreign Origin also fails on cookie
reads. GET/HEAD stay read-only. Trust never derives from Host or forwarded headers. There is no
CSRF-token endpoint and no credentialed cross-origin API access; SameSite is defense in depth.
Narrow cross-site GET exceptions: the Google callback and the bound MCP OAuth callback
(`docs/mcp.md`). MCP OAuth keeps its own state/PKCE/browser binding; if the app session expires
mid-ceremony it fails visibly and the connection restarts, never replaying callback codes through
Google login. Public routes and valid machine or runtime bearers do not need a browser Origin.

## Machine callers

`google-auth-library` verifies Google ID tokens for the exact app-origin audience and the admitted
immutable subject `PI_ORB_MACHINE_SUBJECT`, with explicit `nbf` check. The release derives that
subject from the numeric `uniqueId` of `pi-orb-debug@<project>`, never its email; `infra/api.sh`
sends such tokens. Key fetches have a
five-second timeout, singleflight and a thirty-second refresh/outage cooldown; fresh known keys
skip unrelated refresh work. Key-provider outage and recovery are sanitized edges. A machine
caller never implies a human. These tokens are a different credential class from orb workload
tokens (`docs/workload-identity.md`).

## Hosts

The hosting guard (`http/hosting-access.ts`) admits configured hosts only:

- **App origin** — browser API, WebSockets, login, public routes.
- **Files origin** (`PI_ORB_HOSTING_ORIGIN`) — only hosted/live GET/HEAD and its own
  login/callback; never APIs or WebSockets. Uploaded HTML can run scripts, so this must stay a
  separate origin (`docs/http-exposure.md`).
- **Preview hosts** — only preview traffic and `/__pi_orb/` auth routes (`docs/http-exposure.md`).
- **Broker authority** (`PI_ORB_BROKER_URL`) — only the bearer-authenticated runtime routes
  (`docs/credentials.md`). Not a browser alias. Absent an explicit value,
  local Docker uses `http://host.docker.internal:<port>` and local process hosts
  `http://127.0.0.1:<port>`; cloud uses the app origin. Provider E2E must exercise this authority
  (`docs/postmortems/2026-09-19-consolidation-docker-broker-host.md`,
  `docs/postmortems/2026-10-06-central-docker-checkout-host.md`).

The guard enforces hosts and route isolation; the cookie resolver enforces Origin. Denials emit a
durable `auth-hosting-denied` lifecycle event with method and fixed route identity, never raw
paths, queries or credentials.

## Ownership

A project and all its children have one owner. `projects.owner_user_id` is required; orbs, history,
messages, hosting, uploads and deletions inherit it through `orbs.project_id`. There is no owner
column on orbs, no transfer and no coworker switcher.

- **Own-user defaults.** Browser project list, project creation, personal instructions, git
  identity, owner secrets/skills, usage and the Claude connection use the signed-in user.
- **Company-wide direct access.** Any authenticated coworker may use direct project, orb, history,
  transcript, hosted-file, settings, secret and lifecycle URLs. Exceptions are owner-only: live orb
  files, MCP status, device-login codes and the Claude connection.
- **Ops user selection.** For user-context operations the ops principal must send
  `X-Pi-Orb-User-Id` naming a known user UUID; missing, malformed or unknown → 400. A user
  principal cannot override itself with the header. Resource-specific operations derive the owner
  from the addressed project.
- **Names.** Project names are unique per owner; different owners may reuse a name. Create
  idempotency includes the owner: the same UUID under another owner conflicts.
- **Owner follows the orb.** Codex/GitHub/Claude credentials, orb naming, auxiliary inference,
  personal instructions and git identity all come from the authenticated `orb → project → owner`,
  never the viewer or a request selector. A coworker viewing an orb gets its owner's behavior.
  Same-project spawning inherits the owner.
- **Runtime inspection.** `GET /runtime/v1/orbs` lists the calling orb owner's projects; explicit
  transcript reads stay company-wide (`docs/control-plane-api.md`).

Project instructions, project secrets and MCP stay project-scoped. Cross-user access never exposes
raw broker credentials. Owner IDs and typed failures may be logged; identity assertions,
instruction bodies and secrets may not.

## Migration inputs

The migration job reads optional trusted-operator inputs; fresh databases need none, and runtime
startup never reads them:

- `PI_ORB_ORIGINAL_USER_ID` + `PI_ORB_ORIGINAL_IDENTITY_ISSUER` + `PI_ORB_ORIGINAL_IDENTITY_SUBJECT`
  (all or none): owner for pre-ownership data (migration 023).
- `PI_ORB_USER_ID`: owner for pre-existing credential pointers (migration 024). A local upgrade
  with existing pointers must name their exact owner.
- `PI_ORB_GOOGLE_IDENTITY_MAPPINGS`: JSON `[{userId, oldIssuer, oldSubject, googleSubject}]`
  remapping IAP identities to Google subjects in place (migration 031). In production the mappings
  live in Secret Manager `pi-orb-google-identity-mappings`, referenced only by the one-shot
  migration job, never a workflow input.

All fail closed on partial, malformed, conflicting or unexpected input. None guesses from email,
row order or a first user. Logs record outcome and counts, never identity values. Retire old
identity-serving processes before an identity migration: a table lock cannot stop one returning.

## Invariants

Deterministic tests (`determined`) cover these with pre/post-commit failpoints:

- At most one session per authorization code; a losing callback cannot erase the winner.
- A session cookie is issued only after confirmed identity resolution.
- One identity resolves to one UUID under concurrent logins.
- No admission after expiry; both proxy legs close at expiry.
- A cleared cookie fails; a copied valid cookie still works until expiry.
- A shared sealing key preserves sessions across restarts without sticky routing.
- A late response for a previous principal never resurrects private UI, principal or socket.

## Observability

Login, callback, logout and admission outcomes, provider outage/recovery and configuration
failures are sanitized `auth-*` lifecycle events with request IDs. Routine unauthenticated requests
are not logged as outcomes; request logs keep the 401. Callback query strings and credentials never
enter logs. Before public exposure, Google and MCP callback query protection must cover every log
route, including ancestor aggregated sinks; project exclusions alone are not proof. The product
distinguishes 401, 403 and 503 using the existing session/error UI. While sign-in is required the
web client stops non-probe API calls: a stale polling tab otherwise floods request logs (1,728 rows
in 12 minutes, over the rollout monitor's log query cap).
