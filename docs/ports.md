# HTTP previews

## Decision and current state (2026-10-04)

The user selected complete removal of built-in Tailscale: binaries, runtime supervision,
provider enrollment, credentials, lifecycle cleanup, configuration, and preview-host contracts.
There is currently **no built-in service exposure**. The reverse proxy below is a design
proposal, not implemented or authorized for implementation/deployment. It covers HTTP,
WebSocket and SSE, not arbitrary TCP/UDP. Services can bind to localhost; opening VM inbound
ports is not the proposed solution.

Stable tailnet identity and zero-configuration all-TCP forwarding were requirements of the
2026-08-05 decision, not requirements of the selected scope. Viewer-device enrollment adds
friction; managing keys, retained identity and disposal introduced disproportionate lifecycle
complexity. The enrollment race demonstrated that isolated adapter tests missed a composed
invariant (`docs/postmortems/2026-09-05-tailscale-invalid-key-at-first-boot.md`).
If advanced networking is needed later, the only selected delivery mechanism is a skill,
not product-managed enrollment. No skill, hook recipe or network integration is planned now.
Questions 72–73 (browser preview) record the scope decision; remaining choices are in
`docs/open-questions.md`, questions 74–77 (browser preview). Implementation work lives in `TODO.md`.

## Architecture prerequisite (selected 2026-10-04)

Architecture orb `e67b1120-393c-41c6-94ed-b354d82c526d` must be **merged and
deployed before preview implementation**. [PR #51](https://github.com/schani/pi-orb/pull/51)
is the source of truth for that prerequisite, not evidence of a completed deployment.
It consolidates serving on `pi-orb-issuer`, preserving the exact issuer URL, signing
keys and relying-party trust. It removes IAP in favor of application-managed Google
login with an encrypted, host-only 12-hour session cookie; private VPC connectivity stays.
Consolidation itself introduces no load balancer. Preview work and deployment are not
authorized by this document.

The earlier LB-IAP preview recommendation is superseded by this app-auth architecture.
Any wildcard LB would supply TLS/routing only, a separate unresolved ingress decision.

## Recommended shape (proposal)

```text
Browser → HTTPS wildcard ingress/auth → control-plane preview route
        → preview domain admission → private runtime transport
        → runtime preview service → HTTP adapter → 127.0.0.1:<port>
```

Use one origin per orb and port, for example
`https://p5173-o<canonical-orb-id>.preview.example.net/`, on a **separate registrable
domain** from the application and hosted files. A single-label encoding fits one wildcard
certificate. The control plane constructs URLs from deployment configuration and canonical
orb ID plus explicitly registered port; no provider-issued hostname or per-orb DNS
record is needed. Registration is not a claim that a service is running or healthy.
Initially open previews in a new tab; embedding and public sharing are out of scope.

Keep path and query intact so root-relative assets, redirects and HMR work. Do not put the
app under `/orbs/:id/ports/:port`: that breaks absolute paths and exposes preview JavaScript
on the application origin. Different subdomains under the application's registrable domain
are distinct origins but still same-site and vulnerable to parent-domain cookie interference.
Separate registrable domains, host-only platform cookies and explicit mutation guards avoid
that coupling. Per-port origins isolate service workers, storage and same-origin access.
This is browser isolation for trusted coworkers, not hostile-tenant compute isolation.

### Domain provisioning (proposal)

The legacy deployed infrastructure uses Google-assigned `run.app` origins with native
Cloud Run IAP; the prerequisite above replaces its auth/serving architecture. Neither
that legacy infrastructure nor consolidation provisions a custom-domain LB.
`run.app` provides exact generated service/tag hosts, not user-controlled wildcard
DNS/TLS. It cannot supply the proposed orb/port wildcard.
An owned-domain wildcard is suggested, **not selected**; no available domain is assumed.
Cloud Run domain mapping does not provide wildcard certificates. Choose DNS/TLS/routing
separately in question 74 (browser preview).
For the proposed load balancer, point wildcard DNS at its reserved IP and provision a wildcard
certificate using Certificate Manager DNS authorization, including its validation DNS record.
Google-managed wildcard certificates require this method, not legacy Compute Engine managed
SSL certificates ([certificate support](https://cloud.google.com/load-balancing/docs/ssl-certificates),
[DNS authorization](https://cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth)).
The control plane parses orb/port from the hostname; no per-orb or per-port DNS records are needed.

### Identity and first request

Apply the existing trusted-company admission policy: admitted coworkers can directly access
other coworkers' orbs. Do not invent owner-only preview authorization. Local development uses
the existing fixed developer identity on test-owned loopback hostnames, never a production
anonymous fallback. Preview ingress must expose only preview and narrowly scoped auth routes;
application APIs, runtime APIs, issuer and broker routes are unavailable on preview hosts.

Use the consolidated application's Google login and admitted principal set, not IAP.
The app's host-only cookie does not authenticate a separate preview origin. Question 74 (browser preview)
must select the preview session bootstrap, expiry/revocation and cookie separation contract.
First top-level navigation must complete authentication before delivering application bytes.
Assets, fetches, SSE and WS upgrades need credentials at that exact origin; browser WS clients
cannot supply arbitrary Authorization headers. A login redirect during HMR upgrade is failure.
Expired fetch/upgrade auth returns a recognizable denial; only top-level navigation starts login.
Never trust client-provided identity headers. Qualify routing/backend fencing and preserve
application Authorization independently of platform authentication.

A narrow app-authenticated handoff is proposed: app entry issues a short-lived single-use
grant bound to principal, orb, port and exact return path; the preview origin consumes it
and sets a host-only Secure, HttpOnly `__Host-` platform session cookie. Keep grants out
of upstream requests, logs and referrers; no-store callbacks remove grant material immediately.
Replay, expiry, revocation and CSRF contracts remain open, not a selected implementation.
Do not use a broad parent-domain cookie.

Separate preview-auth cookies from app cookies and preview-application cookies. Strip platform
cookies, identity headers and runtime credentials before forwarding to the
service; filter platform-cookie collisions from upstream Set-Cookie. Preserve ordinary app
cookies scoped to this preview host and application Authorization headers; do not confuse
these with platform/runtime authentication. Select platform-cookie collision handling and
expiry semantics in question 74 (browser preview). Recommend host-only application cookies and rejection of upstream
parent-domain cookies that can affect sibling previews; this remains a proposal in question 77 (browser preview).
App/API and live/terminal WS origin checks must reject preview-origin mutations and credentialed cross-origin reads. SameSite alone is insufficient;
no permissive credentialed CORS. Preview WS should accept its own exact origin; any development
cross-origin exception requires an explicit contract, not wildcard acceptance.

### Admission and private transport

Runtime means the existing orb service, not another host. Today the control plane reaches GCE
runtime HTTP at the VM's private IP on port 8080 through VPC firewall admission; Docker publishes
container port 8080 to a dynamically assigned host-loopback port. Existing control-plane-to-runtime
requests are not generally bearer-authenticated: network reachability is the current boundary
(`apps/control-plane/src/adapters/runtime-client/fetch-client.ts`, `infra/network.tf`).

The HTTP handler validates hostname/request framing and authenticates, then calls a preview
domain service. That service uses the store/lifecycle and runtime-client ports immediately
below it; it never calls raw fetch, provider HTTP or database queries. Extend the existing
private-runtime transport with a streaming preview capability; runtime routes fold into a
runtime preview service whose loopback HTTP adapter owns sockets. Keep Node streams, HTTP
parsing and framework upgrade objects out of domain code. Result/ResultAsync boundaries map
third-party failures narrowly to discriminated errors.

Selected: preview traffic counts as activity and prevents idle stop. It never starts
stopped compute; explicit Stop dominates preview activity. Agent-turn “busy” remains distinct:
preview use must not set the agent to working. Show preview activity as a user-visible idle
activity reason. A gateway is not a new lifecycle owner or reconciler.

Admit only a healthy running orb with no terminal cleanup intent. Selected (2026-10-04):
real requests/application traffic count as activity; silent HMR sockets alone receive no busy
credit. Question 75 (browser preview) still owns active-but-silent request accounting, other idle WS/heartbeat
policy and expiry of activity ownership. Recommend coalescing monotonic last-activity updates
rather than writing the database per byte. Process death and inactivity must not leave immortal busy flags.

Resolve current authority per request; avoid route caches initially. Carry exact orb ID,
incarnation, host execution identity and authorization fence through admission and runtime
connection. Runtime checks the target against its own identity before opening localhost.
Validate runtime identity at connection/upgrade so replacement cannot redirect an old
request into new compute. Admission rejects lifecycle closure observed at its authority check;
a closure committed after that check can race runtime acceptance. Stop/archive/delete/discard
observation closes admission and cancels owned streams. Across control-plane instances use the
existing lifecycle observation path plus bounded revalidation, not only a process-local
notification. Propose shared per-orb lifecycle revalidation every 5 seconds with a 2-second
deadline, failing closed on missed validation, targeting at most 10 seconds to terminate stale
admissions/streams; do not add a database poll per stream. Question 75 (browser preview) must select and test this
bound; it is not atomic admission against lifecycle commits. Authenticate every new request/upgrade.
The lifecycle bound is not an authentication revocation guarantee. Existing-stream auth
termination at platform maximum/session expiry needs a selected contract in question 75 (browser preview);
do not add bespoke Google membership polling. Already delivered
bytes or accepted upstream effects cannot be recalled. No distributed admission lock or new
lifecycle state machine is proposed. Reconnect performs fresh admission; never replay buffered HTTP bodies or
WS messages after a transport failure. Runtime-only restart also ends its owned connections.

Missing orb: resource-specific 404 at the requested URL with dashboard link. Existing stopped,
sleeping, starting, failed, archived or deleting orb: explicit unavailable state, no redirect or
implicit Start. Denied identity/port, target-not-listening, stale incarnation and upstream
failure have distinct typed outcomes. Use suitable 4xx/502/503/504 before headers; after headers
terminate the stream/WS explicitly, never emit a false successful EOF or HTML inside SSE.
An authenticated status response may link to the orb page for manual Start.

### Target and HTTP contract

Selected: explicit CLI/tool registration returns a preview URL; arbitrary unregistered
ports are never forwarded. The smallest proposed persistence is an allowlist keyed by
orb + port. Selected (2026-10-04): registrations survive stop/start. Compute replacement
persistence and other lifetime details remain unresolved in question 76 (browser preview). `pi-orb expose <port>`, `unexpose` and a list
command are illustrative syntax, not selected commands. Registration does not imply readiness.
Registration/revocation authority must fence forwarding at both boundaries; select its
atomicity and bounded existing-stream termination contract before implementation.

Only an integer TCP port in 1–65535 is target input. Canonical hostname parsing must reject
alternate encodings, invalid IDs, suffix confusion and unknown hosts. Neither URLs, DNS names,
IP addresses, Unix sockets nor redirect destinations are user-selected proxy targets. Dial
literal `127.0.0.1` within that runtime's network namespace; never follow upstream redirects.
Recommend plain HTTP over IPv4 for the first GCE/Docker slice, excluding IPv6-only and HTTPS-only
listeners.
Block runtime listener, broker/control-plane listeners, supervisor/health endpoints and other
platform-reserved ports, including dynamically assigned ports. Validate at both control-plane
and runtime boundaries. A process provider shares a network namespace and cannot safely claim
arbitrary per-orb port ownership: qualify an explicit owned-target seam or keep previews
unsupported there. Question 76 (browser preview) holds the exposure/reserved-port policy.

Loopback restriction prevents direct metadata/VPC SSRF, but does not isolate platform services
listening on loopback or sandbox code that itself proxies elsewhere. No firewall widening,
privileged networking or promise of hostile-code containment is implied.

Selected forwarding option 1: preserve normal HTTP semantics with limited application
configuration, no HTML/JS rewriting and no automatic retries. Preserve method, path/query,
streaming body, status, end-to-end headers and binary WS frames.
Use the external preview Host and trusted `X-Forwarded-Proto: https`/host semantics for dev
servers; replace spoofable incoming forwarding headers rather than append them. Vite and
similar servers may require this host in their allowed-host configuration. Do not disable
host validation globally. Preserve relative redirects; qualify any narrow rewrite of absolute
localhost Location/Set-Cookie Domain separately. Do not rewrite HTML, JS or CSP. Apps with a
fixed unrelated public origin or custom TLS-only listener are not automatically supported.
Absolute localhost redirects, OAuth callback origins and cookie Domain behavior require
application configuration or narrowly qualified rewriting, not generic proxy transparency.
Question 77 (browser preview) owns the remaining header/rewrite details and budgets, not the selected option.

Strip hop-by-hop headers and every header nominated by Connection, then perform explicit WS
upgrade handling. Reject ambiguous Content-Length/Transfer-Encoding, malformed authority,
header injection and unsupported upgrade protocols. Streaming upload/download/SSE must apply
backpressure across both hops, with bounded queues, per-stream and total admission limits,
header/connect/idle deadlines and cancellation propagation. Do not buffer complete bodies,
compress/rechunk SSE unnecessarily or wait for EOF before emitting headers/first chunks.
A disconnect/deadline cancels upstream reads/writes and reaps sockets/listeners exactly once.
WS close/error/backpressure propagates both ways; no application reconnect replay. Mutating
requests are never automatically retried, including lost responses after upstream acceptance.
Provisional budgets: 5-second connect, 30-second upstream-header deadline and one-hour stream
maximum. Select idle deadlines and bounded queue/concurrency values from measured streaming
behavior and existing platform defaults; no final memory/socket limits are established yet.

Start with the existing control-plane service if its ingress supports this contract. Cloud Run
WS/SSE are bounded requests (up to the configured maximum, currently documented as 60 minutes),
not immortal channels. HTTP/1 request uploads have a documented 32 MiB limit; an application
body cap cannot override it. Qualify the actual ingress/Cloud Run HTTP versions, upload limits,
response streaming, idle timeouts and connection draining; expose limits without silently
buffering or raising timeouts. A dedicated preview gateway is justified only if those measured
constraints prevent the required previews, not as an initial extra service. Sources:
[Cloud Run quotas](https://cloud.google.com/run/quotas),
[WebSockets](https://cloud.google.com/run/docs/triggering/websockets).

## Tests-first implementation sequence (proposal)

1. First merge and deploy the architecture prerequisite above. Then settle remaining
   questions 74–77 (browser preview) and pin contracts with failing tests. Qualify consolidated app login,
   preview-session bootstrap and HMR on the chosen ingress before committing to that design.
   No deployment or credential mutation is authorized here.
2. Write registration/store/runtime-transport contracts and forced DST schedules below before
   admission/fencing. Reuse lifecycle authority; implement only the selected registration
   lifetime, without speculative registry state.
3. Implement the minimal control-plane and runtime services behind those ports. Add loopback
   adapter tests over real HTTP, WS and SSE, cancellation and bounded-buffer instrumentation.
4. Add browser E2E for real origins, root assets, redirects, cookies, HMR and auth failures,
   then run the full runtime E2E and deployed acceptance below. Add URL discovery/UI only
   once capability exists; a generated address must never claim verified readiness.

### DST boundaries and matrix

Run **production** admission/connection ownership under `determined`, not a parallel model of
its decisions. Reuse `SimulationTask`, task clocks/timers, `runDst`, shared in-memory store,
runtime-client/host fakes and named `testkit/failpoints.ts` vocabulary (`docs/testing.md`).
One task per concurrent request, lifecycle worker or stream pump; never share a sequential task
between workers. Fakes retain accepted upstream work across worker death. Model authorization,
route resolve, target acceptance, header delivery, chunks, upgrade and cancellation as separate
observable boundaries; injected sources/sinks generate chunks and count bytes rather than
hold entire payloads. Node parser/TLS/stream behavior remains real-adapter testing.

| Forced schedule, plus entropy/failpoints | Invariant |
| --- | --- |
| Register/revoke/forward across two CP instances, authority read, runtime dial and worker death | No unregistered dial; enforce selected registration atomicity and bounded stream termination; registration never asserts readiness. |
| Preview traffic versus real idle reaper, explicit Stop and replacement; coalesced updates reordered | Activity prevents idle stop, explicit Stop wins, no wake or agent-working mutation; last activity is monotonic. |
| Active silent requests, idle WS/heartbeats, inactivity and process death | Enforce the selected accounting policy; ownership expires without immortal busy flags. |
| Stop/sleep/archive/delete between auth, store read, route resolve, dial and upstream acceptance | Reject observed closure; stale admissions and existing streams terminate within the selected revocation bound; no wake or retry of accepted work. |
| Replacement/discard/runtime restart before headers, mid-body and mid-WS; delayed cached route | No old request reaches replacement compute; stale endpoint cannot disclose another orb/incarnation. |
| Two CP instances, missed invalidation, worker death and restart | Fresh authority on reconnect; revocation within the chosen bound; no durable replay queue or leaked ownership. |
| Missing versus stopped/archived/deleted orb; malformed host and reserved ports | Distinct errors; requested URL preserved; forbidden target is never dialed. |
| Auth expiry/revocation between admission and upgrade/chunks; handoff replay if selected | Fail closed under the selected expiry contract; no anonymous fallback or cross-orb/port grant use. |
| Disconnect/deadline/error before dial, after acceptance, with both pumps blocked, or simultaneous WS close | At-most-once disposal, bounded abort completion; accepted upstream mutations never retried. |
| Slow consumer/producer, large generated body, concurrent streams and admission saturation | Bounded read-ahead/queued bytes and sockets; unrelated orb progress; no silent truncation or loss of backpressure. |
| Lost headers/response after mutating upstream acceptance; HMR reconnect | At most one forwarded attempt; reconnect is new auth/routing, not message replay. |
| Repeated healthy polls then one blocker/recovery edge | Healthy traffic logs nothing; durable sanitized failure edges match user-visible outcomes. |

Named checkpoints expose registration/revocation commits, authority reads, activity updates,
idle-stop admission, transport acceptance, runtime identity validation, upgrade, revalidation
and disposal races. Test selected stop/start registration persistence; qualify replacement
persistence and deletion once their lifetime contracts are selected. Add chunk/pump checkpoints only where they exercise
production ownership or buffer bounds; do not simulate Node internals or require per-chunk
ceremony. Test invariants at those boundaries and convergence in a final fair phase with
faults disabled. Isolate unrelated idle timers only when outside the
scenario premise; dedicated schedules compose previews with the real idle reaper. Mutation
checks must fail when registration/incarnation validation, reserved-port checks, activity
fencing, cancellation or buffer bounds are removed, or when replay or agent-working mutation
is introduced.

Every DST failure saves its first trace/configuration under `test-failures/`, proves replay,
and is inspected using `DST_REPLAY=<trace> npx vitest run <preview-dst-file> -t '<case>'`
before any fix. No green rerun, larger timeout or weakened assertion clears a failure.

### Real boundaries and acceptance

- Unit/SQL contracts: canonical host/port parsing, registration/revocation and selected lifetime,
  monotonic activity coalescing, policy mapping, typed errors, authority-read semantics and
  header sanitization; simulation store and PGlite/PostgreSQL agree.
- Runtime HTTP integration: localhost-only service, methods/binary uploads, first bytes before
  source EOF, SSE cadence, WS echo/close, slow sinks, measured buffers, abort and socket cleanup.
  Test CL/TE ambiguity, Connection-nominated headers, Host spoofing, redirects and parser quirks
  over real sockets; DST cannot prove HTTP request-smuggling resistance.
- Browser E2E: separate origins and cookies, deep-link first login, relative/root assets,
  secure-context APIs, real Vite HMR, SSE, expiry/re-login, sibling-port storage isolation,
  service worker scope, forbidden app API reads/mutations, and missing-resource messages.
  Assert synchronization signals, not sleeps; own and drain fixture ports/processes/routes.
- Full slice: run `npm ci`, typecheck/lint/unit/DST and `npm run test:e2e` before deploying
  runtime transport/server/harness changes. Exercise Docker and actual native GCE namespaces;
  process-provider coverage cannot imply isolation it does not provide.
- Isolated deployed acceptance after consolidation: chosen DNS/TLS/routing, admitted and
  denied app-login principals, preview-session bootstrap/expiry, no authentication bypass,
  first-request and WS reconnect cookies, registered/unregistered/revoked ports, real
  HMR/SSE/upload/download, Cloud Run limits/timeout/drain, preview activity versus idle stop,
  explicit Stop/replacement fencing, cancellation and bounded memory under slow/concurrent
  transfers. CI's local auth seam cannot establish deployed Google login/session behavior.
  Add a real external-browser preview gate
  only when the feature ships; neither localhost curl nor generated URL proves reachability.

## Observability

Persist edge-deduplicated admission blockers, stale-incarnation termination, auth degradation
and recovery through existing durable lifecycle events; use Cloud Logging for adapter diagnostics.
Persist registration/revocation outcomes and activity reason edges; expose actionable
failure states to the browser. Record orb/port/incarnation, phase, sanitized error code and
correlation ID, not paths/queries, headers, cookies, tokens, grants, bodies or WS payloads.
No per-request healthy lifecycle logs. Aggregate counts, duration/bytes, active streams,
queue high-water marks and cancellation latency establish success and diagnose saturation;
platform access logging must redact credential material too. Diagnostic collection cannot
consume or buffer the forwarded stream. Failures after headers remain explicit interrupted
outcomes; operators must distinguish target refusal, platform timeout and lifecycle closure.

## Removal rollout safety

Tailscale registrations mean enrolled device/node entries and surviving enrollment auth-key
records, not DNS domains or per-service registrations. Consumed non-reusable keys may be absent
while their devices remain. Remaining counts are unknown; no live inventory was performed.

The owner accepts manual Tailscale admin cleanup/revocation after retirement. Product cleanup,
live inventory and absence evidence are **not deployment prerequisites**. Once old provisioning
has stopped, the owner can independently delete old devices and revoke surviving join keys
and the upstream OAuth client; preserve unrelated nodes and retained workspace/history.
No product cleaner or elaborate migration orchestration is required.

The GCP secret `pi-orb-tailscale-oauth-client-secret` holds the OAuth client secret,
not per-orb join keys. Its infrastructure definition was removed; the secret container is
destroyed during apply, not manually afterward. Deleting it does not revoke the upstream
OAuth client or devices. Join keys are managed by Tailscale, with copies in metadata/env;
node identity lives on disk. Upstream admin cleanup is independent of GCP secret removal.
New-image acceptance checks executable absence on the booted artifact. No live inventory,
cleanup, revocation, apply or deployment was performed or authorized by this docs update.

## Retained alternatives and rationale

The original all-TCP tailnet choice avoided wildcard DNS/TLS and proxy code for one user.
Keeping managed access optional, moving daemon supervision into systemd, or mint-only keys
would leave enrollment/disposal complexity; the user selected removal instead. Ephemeral
nodes simplify eventual inactive-device cleanup but do not preserve identity across long
stops or immediate fenced revocation. A future skill may accept those operator-owned limits.

Managed authenticated tunnels are an alternative to building ingress but add another vendor,
credential plane and lifecycle. A tailnet-backed browser gateway keeps enrollment operational
complexity. Provider-native preview proxies do not supply a common Docker/GCE contract.
These remain evaluated alternatives, not selected implementation. Serve can forward any valid
TCP port; Funnel's public HTTPS listeners are limited to 443/8443/10000
([Serve](https://tailscale.com/kb/1242/tailscale-serve),
[Funnel](https://tailscale.com/kb/1223/funnel)). Neither provides the selected browser ingress
without additional identity/target setup. Public unauthenticated preview sharing is out of scope.
