# HTTP exposure

Three ways to reach orb content over HTTP, all served by the one application:

- **Previews**: a registered loopback port of a running orb, on its own origin.
- **Hosted files**: durable copies published with `pi-orb host`, readable after stop or archive.
- **Live file links**: current bytes of a guest file while the orb runs.

None is public. App authentication and ownership: `docs/auth.md`.

## Origins

| Origin | Config | Serves |
| --- | --- | --- |
| App | `PI_ORB_APP_ORIGIN` | Dashboard, API, WebSockets |
| Files | `PI_ORB_HOSTING_ORIGIN` | Hosted `/s/…` and live `/files/…` GET/HEAD, its login/callback |
| Previews | `PI_ORB_PREVIEW_ORIGIN` (optional) | `p<port>-o<orb-uuid>.<preview-base-host>` |

Uploaded and previewed code runs scripts, so each must sit on an origin with no app authority. Host
choice, not service topology, sets the same-origin boundary. Rejected: serving files on the app
origin under a CSP sandbox, whose opaque origin breaks scripts and does not replace origin checks.

- In cloud, files use the application's `files` traffic-tag origin (`docs/deployment.md`).
  `*.run.app` is on the Public Suffix List, so app and files cannot share cookies.
- `PI_ORB_PREVIEW_ORIGIN` is an exact HTTPS base origin (no path, query, fragment or trailing
  slash). The control plane checks it is a separate registrable domain from app and files using
  the PSL including private domains: subdomains of the app's domain still leak same-site and
  parent-domain cookies. Production uses `https://piorb.live`. One host per orb/port isolates
  cookies, storage and service workers between ports. Unset disables preview registration.
- Locally, files default to `http://files.localhost:7100`; local auth mode alone allows test-owned
  HTTP localhost preview names. Production never falls back to anonymous.

## Authentication and admission

### Access policy

| Resource | Browser session | Orb access token |
| --- | --- | --- |
| Preview | any admitted coworker | token orb's owner's orbs |
| Hosted file `/s/…` | any admitted coworker | token orb's owner's orbs |
| Live file `/files/…` | target orb's owner only | token orb's owner's orbs |

### Files host login

The files origin runs the app's Google login with its own callback and host-only sealed session
cookie (same lifetime, `docs/auth.md`). Only unauthenticated top-level document navigation starts
login; HEAD, assets and API-shaped requests get typed errors. `returnTo` must be a files read path.
No shared-domain cookie, app-token handoff, signed URL or files logout: the files session expires
independently of app logout.

### Preview login

The app session does not authenticate a preview origin.

1. An unauthenticated GET document navigation on a preview host sets an encrypted host-only Secure
   HttpOnly SameSite=None challenge cookie (ten minutes) and redirects to app `/auth/preview`.
2. App login supplies the principal. The app returns no-store HTML with a nonce CSP that
   auto-POSTs an encrypted 60-second ticket to the exact preview callback under `/__pi_orb/auth/`.
   Tickets travel in POST bodies, never URLs.
3. The callback requires the exact app Origin, a body ≤ 16 KiB and a matching challenge
   purpose/proof/origin, and clears the challenge on failure too.
4. It sets `__Host-pi-orb-preview`: Secure, HttpOnly, host-only, SameSite=Lax, carrying the app
   session's fixed expiry without renewal.

The handoff page uses `Referrer-Policy: strict-origin`: real Chromium sends POST `Origin: null`
under `no-referrer` or `same-origin`. Only the app origin leaks as Referer. Other auth responses use
`no-referrer`.

Assets, fetches, SSE and WebSockets without a session get 401; only document navigation starts
login. Everything is stateless: a copied ticket plus challenge replays until expiry; a copied
session survives app logout and Google membership changes until expiry. Active streams end at
session expiry, with watcher granularity.

### Orb access tokens

An orb's agent or scripts reach previews and files with its own workload identity token:
`pi-orb id-token --audience urn:pi-orb:access` (`docs/workload-identity.md`), in Pi and Claude
orbs alike.

- Sent as header `x-pi-orb-token`, or as host-only cookie `__Host-pi-orb-token` on the target
  origin. The header wins. The cookie exists because agent-browser's origin-scoped headers do not
  reach WebSocket upgrades.
- Preview and files hosts verify signature against the published keys, exact issuer and
  audience, `token_use` and expiry (≤ 1 hour; expiry is the only revocation).
- Admits only orbs whose project owner equals the `orb_id` orb's owner, including across projects
  and spawned orbs. Narrower than the owner's own browser access. A missing target passes through
  so the resource route reports that it doesn't exist. On hosted paths the orb ID must be canonical.
- A presented token is the request's only credential: rejection is 401/403, never a login
  redirect. Outcomes use `preview-auth-admission`/`auth-admission` events with `token_*` reasons.
- No persisted state. Accepted risk: a leaked token works for up to an hour within that owner's
  orbs. Rejected: a separate sealed access token with its own CLI and route; browser handoffs;
  `Authorization: Bearer` (owned by preview apps); single-use tokens (need state).

### Stripping and isolation

Before anything reaches a preview application: platform cookies, known platform identity headers,
`x-pi-orb-*` headers and `__Host-pi-orb-*` cookies are stripped; ordinary `x-goog-*` headers stay.
Application `Authorization` and host-only cookies remain the application's. Upstream Set-Cookie
with a Domain attribute or a platform-name collision is rejected. No credentialed wildcard CORS.
Paths like `/api` or `/runtime` on a preview host belong to the preview app.

### Limits and logging

Cloud Run's HTTP/1 request limit is 32 MiB even when streamed
([quotas](https://cloud.google.com/run/quotas)); larger preview uploads get 413, and hosted-file
uploads are capped at 32 MiB. The service request timeout is one hour.

Preview-host Cloud Run request logs are excluded from `_Default` (`infra/preview.tf`), and the files
origin is excluded from request-URL logs (`infra/hosting.tf`), both before activation, because
OAuth codes and paths may appear anywhere. Exclusions cover request logs, not audit logs,
custom/ancestor sinks, LB logs or upstream application logs; those need separate verification
before exposure. Verify that an exclusion filter actually matches; doubled backslashes once made
one match nothing (`docs/postmortems/2026-11-03-preview-request-log-exclusion.md`).

## Previews

HTTP, WebSocket and SSE to registered plain-HTTP IPv4 loopback ports on isolated GCE or Docker
compute. The shared-namespace process provider is unsupported. No raw TCP/UDP. Previews open in
their own tab, never under an app path or embedded. This is trusted-coworker browser isolation, not
hostile-code containment.

```text
Browser → HTTPS edge (Host preserved) → application preview gateway → admission/store
        → private runtime transport → runtime preview service → 127.0.0.1:<port>
```

### Registration

- Claude orbs: `pi-orb expose <port>`, `pi-orb unexpose <port>`, `pi-orb previews [--json]` →
  bearer-authenticated `PUT|DELETE /runtime/previews/:port` and `GET /runtime/previews`
  (`{preview}`, `{previews}`, 204).
- Central-Pi orbs: `orb_expose_port`, `orb_unexpose_port`, `orb_list_previews`, calling the same
  service in-process.
- The `orb_expose_port` description and `pi-orb expose` help carry the URL, readiness and
  no-autostart rules; Claude's system prompt has a fixed `## Port exposure` section.
- Unset preview origin returns a configuration-disabled error, never a fabricated URL.
  Registration asserts nothing about readiness.

The store keeps an orb/port allowlist with a random registration generation. Idempotent
re-registration keeps the generation; revoke then register changes it. Registrations survive
stop/start and replacement; orb deletion cascades. Mutations recheck lifecycle and caller authority
under store locks: runtime callers by bearer and incarnation on running compute; central callers by
owner and agent admission version (so they may register while compute is stopped). Ports are
1–65535 excluding runtime port 8080, the runtime's actual listeners and the control plane's local
listeners. No URL, address or socket is selectable.

### Admission

Every request and upgrade reads current authority: healthy running compute, registration, no
cleanup, discard or Stop intent, isolated provider. Host observation and runtime health must agree
on orb and incarnation; ready health supplies execution ID and runtime instance ID (mandatory
here). No stale route cache; never an implicit Start.

Private transport uses fixed `/v1/preview/:port`. The original path/query travels in
`x-pi-orb-preview-path` as base64url UTF-8 (≤ 16,384 encoded chars / 12,288 bytes), avoiding URL
normalization escapes. Platform failures carry `x-pi-orb-preview-error`, consumed and stripped by
the control plane; application statuses pass unchanged.

Signed admission covers orb, port, registration generation, incarnation, execution ID, runtime
instance ID, origin and expiry: HMAC-SHA256 keyed by `runtimeTokenHash` with prefix
`pi-orb-preview-admission-v1\n`. The runtime derives the key from its bearer; neither key nor
bearer is forwarded. The control plane signs for 5 s; the runtime accepts at most 10 s ahead,
leaving 5 s skew either way (`docs/postmortems/2026-11-03-preview-admission-clock-skew.md`). The
runtime checks signature, expiry and its own exact identity before dialing. Pi/Claude runtimes and
the central-Pi execution runtime serve the same route; the execution runtime exempts it from its
bearer check. Registration and dial are not atomic: observed closure rejects, later closure cancels
through revalidation, delivered bytes cannot be recalled.

A per-orb watcher revalidates every 5 s with a 2 s deadline and fails closed; stale streams close
within 10 s. Local lifecycle closure cancels owned connections.

### Activity lease

A durable 15-second lease protects idle-stop CAS.
In-flight HTTP/SSE requests count even when silent; WebSocket application messages renew it;
silent HMR sockets and protocol heartbeats do not. Admission grants an initial short lease, never
indefinite WebSocket credit. Runtime activity admission also excludes persisted idle-stop
preparation without marking the agent working. Explicit Stop overrides previews; owner loss lets
the lease expire. `OrbView.previewActiveUntil` drives the static `preview` state word (no busy animation), shown
only for a running orb with an unexpired lease and no busy agent. Scheduled sleep stays visible.

### HTTP contract

Method, path/query, streaming body, status and end-to-end headers pass through. Forwarding headers
are replaced with Host and trusted scheme/host from the signed origin; hop-by-hop and
Connection-nominated headers are stripped. No HTML/JS/CSP rewriting, redirect following, retries or
replay. Relative redirects work; absolute localhost redirects, OAuth origins, host allowlists and
HTTPS-only or IPv6-only listeners need application configuration. Preview WebSockets require their
exact origin.

Before headers, typed failures distinguish missing orb, unavailable compute, unregistered port,
auth, stale target, refusal and upstream failure; missing resources keep the URL and link to the
dashboard. After headers, failures abort the stream rather than fake EOF or inject HTML. The runtime
must not cancel accepted WebSockets on TCP close (normal browser closes otherwise reached the app
as 1006).

Limits: 5 s connect, 30 s headers, one-hour stream, 128 streams total / 16 per orb, 1 MiB preview
WebSocket queue and frame. The shared browser WebSocket parser stays 8 MiB (6 MiB prompts); private
preview parsing is 1 MiB. These are caps, not measured guarantees.

### Ingress

`infra/variables.tf` `preview_origin` feeds `PI_ORB_PREVIEW_ORIGIN` and `infra/preview.tf`: global
address, Certificate Manager DNS authorization and `*.piorb.live` certificate/map, serverless NEG to
`pi-orb-issuer`, backend with edge logging disabled, HTTPS proxy and 443 forwarding rule, wildcard A
record, and the request-log exclusion. `piorb.live` is delegated to the foundation's Cloud DNS zone
`pi-orb-preview`. The edge preserves Host, path/query and Upgrade; no IAP, alternate issuer or extra
service. Previews fail TLS until certificate validation completes. Rejected: a self-operated nginx
edge; Cloud Run domain mapping (no wildcard certificate).

Rejected: built-in Tailscale and all-TCP access; viewer enrollment, key and disposal complexity
outweighed zero-config TCP (`docs/postmortems/2026-09-05-tailscale-invalid-key-at-first-boot.md`).
Managed tunnels add a vendor plane; a dedicated gateway needs measured need. Public sharing is out
of scope.

### Observability and tests

Durable deduplicated edges for registration/revocation, admission, forwarding failure/recovery and
termination, carrying sanitized orb/port/incarnation/execution/runtime instance, phase and reason;
after-header failures and WebSocket overflow too. Healthy traffic is quiet. URLs, queries, headers,
cookies, tickets, bodies and payloads are never recorded. Registration, admission ownership, idle
CAS, Stop, owner death, stale incarnation and cancellation run under `determined`; sockets, parsers,
backpressure and browser cookie/origin behavior are adapter and E2E tests.

## Hosted files

Durable static files per orb, under the immutable orb ID; names never enter storage identity.
They survive replacement, stop/start and archive.

```text
pi-orb host file.html design/index.html   # publish; prints canonical URL
pi-orb host ls
pi-orb host rm design/index.html
```

URL: `<files-origin>/s/<orb-uuid>/<path>`. `/design` → 308 `/design/`, which serves
`design/index.html` so relative assets resolve. No directory listings. Republishing replaces what
later reads return.

Wire: raw-byte `POST /runtime/v1/hosting/files?path=…`, `GET` lists, `DELETE` removes, all scoped by
the bearer to the caller orb. The CLI owns file reading, MIME hints, a five-minute deadline, typed
errors and lost-response wording. Browser: `GET /api/v1/orbs/:orbId/hosted-files` →
`{files: [{path, url, size, mediaType, updatedAt}], cleanupIssues: [{path|null, lastError,
lastErrorAt}]}` for working and archived orbs. The orb header's Hosted Files disclosure (`docs/web-ui.md`)
lists path, URL, size and update time, and keeps fetch and cleanup errors
visible; hashes stay internal.

### Streaming

Uploads stream CLI → runtime route → GCS resumable upload (256 KiB chunks); downloads stream GCS →
route → response. Each leg honors backpressure and cancellation and hashes incrementally. Transfer
paths never use `readFile`, full-body parsers, `arrayBuffer`, `blob`, base64, one full-content
Buffer or temp files. Browser downloads use navigation, not `fetch` + Blob. Per-file limit 32 MiB
(the Cloud Run limit above; larger needs end-to-end HTTP/2 or multi-request upload). GCS itself
allows 5 TiB.

### Storage and publication

Bytes live in a dedicated private GCS bucket (filesystem root locally, in-memory fake in DST).
PostgreSQL is authoritative: catalog rows hold orb ID, normalized path, immutable object reference,
size, media type, hash, created and updated times; `(orb_id, path)` unique. Hosting is a
control-plane capability, not a host-provider method: any provider's orb uploads through the same
API without a GCS credential. A multi-instance non-GCP control plane would need a shared object
store.

Publication never overwrites an object:

1. Transactionally fence the caller's incarnation and state and record an upload operation owning
   a new object reference.
2. Stream and hash bytes into it.
3. In one transaction, recheck the fence, swap the catalog pointer, mark published and queue the
   superseded object for cleanup.

The CLI sends a UUID request ID bound to orb, incarnation, path, media type, size and SHA-256. Exact
replay returns the original acknowledgement; different parameters conflict. No source bytes flow
until the resumable session URI is durably registered, so a lost begin leaves only an empty
inaccessible session. Known data-capable sessions must reach confirmed cancellation or verified
completion before deletion and orb finalization; lease expiry is never proof. If completion beats
cancellation, cleanup deletes the returned exact generation. Session URIs are secrets, never logged.

Removal unpublishes the path and moves the exact object into a cleanup intent, deleted afterwards
and retired only after confirmed absence. Upload and cleanup claims use lease expiry plus monotonic
epochs; authorization and claim checks stay inside the mutating transaction with the existing lock
order. The filesystem adapter keeps content-free terminal session markers for delayed callers.

### Serving

The route resolves orb and path, snapshots that exact object generation and streams it with
`Cache-Control: private, no-cache`, content-hash `ETag` (conditional 304), `nosniff`. Reads take no
lease; concurrent permanent deletion may interrupt a read, never yielding clean EOF on truncated or
mixed bytes. Missing paths keep the URL and return a file-specific 404 with a dashboard link. No
CDN or public sharing.

### Lifecycle

Upload, replace and remove require a currently authorized incarnation, fenced in the publishing
transaction. `archiving` admits no new publication; archive keeps catalog and objects. Permanent orb
deletion (and project deletion through it) enumerates catalog and operation ownership, deletes
every object, session and abandoned operation, then lets the row go; no cascade may erase the
inventory. The bucket disables soft delete, versioning and retention.

### Invariants and observability

- Every catalog pointer names one complete immutable object with matching size, type and hash.
- Concurrent replacement linearizes to one value; a download emits one generation or an explicit
  failure.
- Every object and data-capable session has exactly one durable owner; finalized deletion leaves
  none.
- Lost responses replay safely; commit ambiguity never creates a second publication.
- Healthy reads log nothing. Publication, replacement, removal, reconciliation and blocked cleanup
  are sanitized, edge-deduplicated durable outcomes, and blocked cleanup appears in the UI.

Domain: `apps/control-plane/src/domain/hosting.ts`; DST `hosting.dst.test.ts`. The real-GCS
contract runs only with `PI_ORB_TEST_HOSTING_BUCKET`. Open: atomic folder publication (question 51),
`bytea` storage (question 56).

## Live file links

Current bytes of a guest file, read through the running runtime. No per-file publication,
object storage, preview registration or persisted state.

```text
<files-origin>/files/<orb-uuid><encoded-absolute-path>
<files-origin>/files/repo/<orb-uuid>/<encoded-repository-relative-path>
```

Segments are percent-encoded, `/` preserved. Relative assets stay on their branch.

### Exposure

**Any HTML on the files origin, including published `/s/…` copies, can read and exfiltrate every
live file the signed-in owner can read, across orbs and projects.** Paths provide no browser
isolation. The user accepted this over per-orb origins (wildcard ingress, awkward in cloud
development). Live responses reject service-worker script requests; workers may already be
installed on the hosting origin. Responses: inline HTML, proper MIME for text and web assets,
`no-store`, `nosniff`, `no-referrer`, no CORS. No listings, indexes, search or writes. The
files-only allowlist runs before app routing.

Isolated guests expose any ordinary file the agent can read, including secrets and tmpfs. Symlink
components, special files, `/proc`, `/sys`, `/dev` and proc/sys aliases are rejected and the opened
descriptor is validated. Process hosts expose only the canonical `PI_ORB_WORK_DIR` workspace
(repo, home, uploads); missing configuration fails closed. Not a hostile-filesystem sandbox or an
atomic snapshot.

### Read path

Ingress → owner and readiness admission → authenticated runtime transport → GET/HEAD
`/v1/files?path=<abs>` or `?base=repo&path=<rel>` → filesystem adapter. Ownership and the running
incarnation are checked at admission only; the runtime checks bearer, incarnation header and
readiness. No watchers, leases, auto-start or keep-awake. One request-wide deadline covers admission
and streaming, capped at 120 s and auth expiry; streams are bounded and backpressured, and
after-header failures abort. Missing file or orb → 404; stopped compute → 503. Browser errors keep
the URL and link to the dashboard. `pi-orb host` is the durable alternative.

`OrbView.filesBaseUrl` is derived from configuration and orb ID, not stored.

### Compact Markdown links

The shared environment prompt (Pi and Claude, root and child) includes this exact text:

> When referring to an orb-local file in prose, use a Markdown link with `orb:<repository-relative-path>` (for example, `orb:README.md`) or `orb:/absolute/path`. Percent-encode each path segment. Keep filesystem paths unchanged inside code and commands. Resolve absolute paths with `pwd`/`realpath`; do not assume a workspace root.

`orb:README.md` resolves against `PI_ORB_WORK_DIR/repo`, not `process.cwd()`; `orb:/path` must be
an actual path, never a virtual alias (an agent that assumed the Docker workspace root on a
process host got 403). The UI rewrites Markdown inline, reference and explicit-autolink destinations using the viewed
orb's `filesBaseUrl`, after CommonMark normalization (raw `%` becomes `%25`); malformed or
authority-bearing forms and missing metadata render non-clickable. Images, bare autolinks, raw history and code stay untouched.
Raw `orb:` URIs need the originating orb's context; copy HTTPS links to share.

### Development access

With the process provider, links use the absolute canonical host workspace path. `*.localhost`
resolves on the reader's machine, so such links cannot be shared from a cloud backend.

To develop pi-orb inside an outer orb, register two previews at startup:

- port 7100: the control plane; set `PI_ORB_APP_ORIGIN` to its returned preview origin;
- port 7101: a Host-preserving forwarder; set `PI_ORB_HOSTING_ORIGIN` to its origin.

```sh
socat TCP4-LISTEN:7101,bind=127.0.0.1,reuseaddr,fork TCP4:127.0.0.1:7100
```

Fastify listens on 7100 and the files allowlist selects by Host. Use returned URLs, never
constructed ones; no `PI_ORB_PREVIEW_ORIGIN` is needed. Outer preview login or a production orb
token admits the outer port; the inner `PI_ORB_AUTH_MODE=local` then acts as its fixed developer, so
coworkers reaching the outer preview act as that developer too. Outer previews strip
`x-pi-orb-token`; inner-issuer tokens are not trusted outside.

### Observability and tests

Failures and recoveries are deduplicated lifecycle edges with target and typed status; healthy
reads are quiet; raw paths, queries, tokens and content are never logged. Browser E2E navigation
waits for the target's non-3xx main-frame response, not `page.goto()`'s intermediate login-handoff
HTML.
