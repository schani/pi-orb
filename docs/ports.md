# HTTP previews

## Decision and implementation (2026-10-06)

Authenticated HTTP, WebSocket and SSE previews are authorized for implementation, not
deployment. Built-in Tailscale and arbitrary TCP/UDP exposure are outside this scope.
The implementation uses registered plain-HTTP IPv4 loopback ports in isolated GCE/Docker
compute. The shared-namespace process provider is unsupported. No public domain is selected,
no preview ingress is provisioned, and local qualification is not deployed acceptance.
Remaining ingress choices are in `docs/open-questions.md`; acceptance work is in `TODO.md`.

Architecture prerequisite: [PR #51](https://github.com/schani/pi-orb/pull/51) merged as
`3c03e4200b8220fa097b97b379cc20c851527103` October 5, 10:30 PM PDT.
[Deploy 37469707425](https://github.com/schani/pi-orb/actions/runs/37469707425)
validated descendant `404cf7b1d54fff65ca09844e6cd9b2a1af8ff1ca` October 6, 7:06 AM PDT,
as `pi-orb-issuer-00043-2k5`; its [artifact](https://github.com/schani/pi-orb/actions/runs/37469707425/artifacts/11418743296)
records all twelve release gates passed. Consolidation preserves the exact issuer URL,
signing keys, relying-party trust and private VPC connectivity. Preview routing uses this
same application with app-managed Google login, not IAP; no issuer URL change is allowed.

## Architecture

```text
Browser → Host-preserving HTTPS edge → consolidated application preview gateway
        → domain admission/store → private runtime transport
        → runtime preview service → HTTP adapter → 127.0.0.1:<registered-port>
```

`PI_ORB_PREVIEW_ORIGIN` is an optional exact HTTPS base origin, with no trailing slash,
path, query or fragment. The control plane validates separation from application and hosted
files using the public suffix list including private domains. Each orb/port has a single-label
host `p5173-o<canonical-orb-id>.<preview-base-host>`, suitable for wildcard DNS/TLS.
This isolates cookies, service workers, storage and same-origin access between ports.
Different subdomains of the application's registrable domain are insufficient: same-site
and parent-domain cookie interference remain. Local mode alone allows test-owned HTTP
localhost names and the fixed developer identity; production never falls back to anonymous.

Previews open separately, not under an application-origin path or in an embedded panel.
Only preview application traffic and reserved `/__pi_orb/` authentication routes execute on
preview hosts. Paths such as `/api` and `/runtime` there belong to the preview application,
never the control plane, issuer or broker. App API/live/terminal origin guards remain intact.
This is trusted-coworker browser isolation, not hostile-code compute containment.

### Registration and lifetime

Use `pi-orb expose <port>`, `pi-orb unexpose <port>` and `pi-orb previews`.
Only `pi-orb previews` supports `--json`.
The runtime's bearer-authenticated PUT/DELETE `/runtime/previews/:port` and GET
`/runtime/previews` call the registration service. Unconfigured origin returns an explicit
configuration-disabled error, not a fabricated URL. Registration does not assert readiness.

Migration 034 persists an orb/port allowlist with a random registration generation.
Idempotent registration retains the generation; revoke then re-register changes it.
Registrations survive stop/start and compute replacement; orb deletion cascades them.
Mutations recheck parent/orb lifecycle, token and incarnation under store locks. Ports are
integers 1–65535; the CP excludes runtime port 8080, and runtime admission excludes its actual
listener/reserved ports. Actual local CP listeners are excluded, not remote HTTPS port 443.
No URL, DNS name, address or Unix socket is a selectable target.
Only registered targets are authorized; registration and dial are not a distributed atomic
transaction. Observed closure rejects admission; later closure cancels through bounded
revalidation. Already accepted upstream effects and delivered bytes cannot be recalled.

### Authentication

Existing admitted coworkers can access other coworkers' previews; no owner-only policy is added.
The application's host-only session does not authenticate a separate preview origin.
Unauthenticated GET document navigation creates an encrypted host-only Secure HttpOnly
SameSite=None challenge cookie (ten minutes) and redirects to app `/auth/preview`.
Application Google login supplies the principal and fixed application session expiry.
The app returns no-store HTML with nonce CSP and `Referrer-Policy: strict-origin`, auto-POSTing an encrypted
60-second handoff ticket to the exact preview callback. Tickets are POST bodies, never
query parameters. Callback requires the exact app Origin, bounded form body (16 KiB),
and matching sealed challenge purpose/proof/origin; it clears the challenge on failure too.
Real Chromium rejected both `no-referrer` and `same-origin` on the handoff form: each
suppressed POST Origin to `null`. `strict-origin` retains the exact Origin and sends only
the app origin as Referer, never the handoff path/query. Other auth responses remain
`no-referrer`; callback Origin acceptance is unchanged.

The preview `__Host-pi-orb-preview` session is Secure, HttpOnly, host-only and SameSite=Lax.
It inherits the application's fixed 12-hour session expiry, without renewal. Assets, fetches,
SSE and WS without authentication return 401, not a login redirect; only document navigation
starts login. Sessions and handoffs are stateless: copied ticket plus challenge can replay
until expiry. Copied session cookies remain valid until fixed expiry; app logout and Google
membership changes do not instantly revoke them. No single-use or membership-polling claim.
Active streams terminate at session/stream expiry, with watcher scheduling granularity.

Platform cookies and known platform identity headers are stripped before upstream delivery;
ordinary `x-goog-*` application headers are preserved. Ordinary application
Authorization and host-only cookies remain independent of platform auth. Upstream platform
cookie collisions and all Domain-bearing Set-Cookie headers are rejected; there is no broad
parent-domain cookie. Application cookies should be host-only. Preview WS requires its exact
origin. No credentialed wildcard CORS or generic cross-origin development exception.

### Admission, backend identity and activity

Every request/upgrade reads current store authority and requires healthy running compute,
registration, no cleanup/discard/Stop intent and an isolated provider. Host observation and
runtime health must agree on orb/incarnation; ready health supplies execution ID and runtime
instance ID. These are mandatory for previews even where health fields are optional for other
clients. No stale route cache or implicit Start is used.

Private HTTP and WS use fixed `/v1/preview/:port`. Original path/query travels in
`x-pi-orb-preview-path` as canonical base64url UTF-8 (16,384 encoded characters / 12,288
decoded bytes maximum), avoiding URL normalization and private-route prefix escapes.
Both boundaries strip application-spoofed reserved headers. Private platform failures carry
`x-pi-orb-preview-error`; CP consumes it as a typed error and strips it, while ordinary
application status codes remain unchanged. Signed admission carries orb, port, registration
generation, incarnation, execution ID, runtime instance ID, origin and expiry. The signed admission lasts at most
10 seconds. HMAC-SHA256 uses `runtimeTokenHash` as its key and the purpose prefix
`pi-orb-preview-admission-v1\n`; the runtime derives the same key from its bearer token.
Neither the key nor runtime bearer is forwarded to the preview service. Runtime verifies
signature/expiry and its own exact target identity before opening localhost. It does not
maintain a second registration database. Application Authorization is never remapped.

A shared per-orb CP watcher revalidates authority every 5 seconds with a 2-second deadline,
failing closed on missed validation; target stale-stream closure is within 10 seconds.
Local lifecycle closure also cancels owned connections. A durable 15-second activity lease
protects idle-stop CAS. HTTP/SSE in-flight requests count even while silent; actual WS
application messages renew activity. A silent HMR socket or protocol heartbeat alone does not
renew it. Admission gets an initial short lease, not indefinite WS busy credit.
Runtime activity admission also excludes persisted idle-stop preparation without changing
agent health to working. Explicit Stop overrides previews. Owner death/inactivity lets the
lease expire; no immortal busy flag. The UI shows `preview` only for a running, unexpired lease
with no agent busy activity. Scheduled sleep remains visible.

### HTTP and resource contract

Method, path/query, streaming body, status and end-to-end headers are preserved. Replace
spoofed forwarding headers with Host and trusted scheme/host derived from signed admission
origin; strip
hop-by-hop and Connection-nominated headers. No HTML/JS/CSP rewriting, redirect following,
automatic retries or accepted-body/message replay. Relative redirects work; absolute localhost
redirects, OAuth/public origins, allowed-host lists and HTTPS-only/IPv6-only listeners need
application configuration. Do not disable development server host checks globally.

HTTP pumps use backpressure and cancellation rather than full-body buffering. Before headers,
typed failures distinguish missing orb, unavailable compute, unregistered port, auth, stale
target, refusal and upstream failure. Missing resources preserve the URL and link to the
dashboard; unavailable orbs never silently redirect or start. After headers, failures interrupt
the stream/WS, not false EOF or injected HTML in SSE.

CP transport has 5-second connection and 30-second header deadlines, a one-hour maximum stream,
128 total/16 per-orb owned streams and a 1 MiB preview WS queue/frame bound. The shared browser
WS parser remains 8 MiB to preserve existing live/runtime prompt admission (6 MiB prompts);
private CP-to-runtime preview parsing is capped at 1 MiB. Runtime WS buffers are bounded too.
These implemented caps are not measured deployed memory/throughput guarantees.
Cloud Run's configured request timeout is one hour; actual upload/stream/WS/drain behavior
still requires ingress acceptance. Its documented HTTP/1 upload limit is 32 MiB; app settings
cannot override that ([quotas](https://cloud.google.com/run/quotas),
[WebSockets](https://cloud.google.com/run/docs/triggering/websockets)).

## Operator ingress contract

`infra/variables.tf` exposes optional `preview_origin`; `infra/run.tf` injects it only into
the existing consolidated application. Empty leaves registration disabled. This is configuration,
not DNS/TLS provisioning or deployment admission. `run.app` only supplies generated exact service
hosts, not user wildcard DNS/TLS; Cloud Run domain mapping provides no wildcard certificate.

After selecting an owned separate domain and DNS authority, operate a TLS reverse-proxy edge:

1. Route `*.<preview-base-host>` to the existing `pi-orb-issuer` Cloud Run application.
2. Preserve the original canonical Host, path/query and Upgrade through the backend hop;
   TLS SNI may use the backend's exact Cloud Run hostname. Do not substitute the issuer Host
   or rely on a client-supplied forwarding header for routing. Qualify actual Cloud Run handling.
3. Terminate valid wildcard HTTPS at the edge; no IAP, alternate issuer or extra app service.
4. Disable URL/query/header/body logging at the edge and audit every downstream sink before
   exposure. Verify registration, auth and streaming from an external browser.

A GCP external application LB/serverless NEG is an ingress candidate, not a provisioned resource.
For it, select the domain/managed DNS zone, reserve the IP, create wildcard DNS and use
Certificate Manager DNS authorization plus its validation record; legacy Compute Engine managed
SSL certificates do not supply wildcard issuance ([DNS authorization](https://cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth)).
No domain, certificate or LB was selected/applied by this implementation.

## Testing and observability

Tests precede production changes. Production admission/connection ownership and registration
run under `determined` with task clocks, store/runtime seams and named checkpoints. DST composes
registration/revocation, idle CAS, explicit Stop, owner death, stale incarnation and cancellation;
real socket/parser/backpressure and browser cookie/origin behavior remain adapter/E2E tests.
First failures and replay logs remain under `.context/http-preview` and `test-failures/`.
Pre-rebase qualification (2026-10-07) passed clean installation, typecheck, lint, full unit/DST,
infrastructure and the complete Docker/browser E2E suite. That result does not qualify the
rebased tree; scoped rebase results, counts, image identity and fixture limits are in
`docs/testing.md`. Neither qualifies deployed ingress or live native/GCE acceptance.
Remaining exposure work is tracked only in `TODO.md`; runtime/server/harness changes require
`npm run test:e2e` before deploy.

Selected minimal observability (2026-10-06): the persisted lease and visible `preview` reason,
plus durable deduplicated registration/revocation, admission, forwarding failure/recovery and
termination edges. Transport edges carry sanitized orb/port/incarnation/execution/runtime instance,
phase and reason; after-header failures and browser WS overflow are recorded too. Healthy
requests and normal connection start/end/EOF/cancellation stay quiet. Application URLs, queries,
headers, cookies, tickets, bodies and WS payloads are not recorded. Aggregate byte/queue/cancellation
metrics are not implemented; they are not part of this selected first observability contract.

Application request logging is disabled. With `preview_origin` set, `infra/preview.tf` excludes
canonical preview-host Cloud Run **request** logs from project `_Default` before service activation,
because application OAuth codes/secrets may occur on any path/query. It does not exclude audit
logs. This exclusion alone does not protect custom/ancestor sinks, LB/proxy access logs or
upstream application logs. Their configuration and deployed absence evidence are prerequisites
for exposure; no all-sinks no-query-logging guarantee is claimed from local contracts.

## Retained decisions and alternatives

The 2026-10-04 removal decision replaces the 2026-08-05 all-TCP tailnet requirement. Viewer
enrollment and key/identity/disposal complexity outweighed zero-configuration TCP forwarding;
the enrollment race also exposed a composed invariant missed by isolated tests
(`docs/postmortems/2026-09-05-tailscale-invalid-key-at-first-boot.md`). Optional managed access,
systemd supervision and mint-only enrollment retain that complexity. Future advanced networking
may be skill-only; no skill is selected now.

Owner-managed Tailscale admin cleanup after retirement is accepted, not a deployment blocker.
Device/auth-key inventory and upstream revocation were not performed. Removing the GCP OAuth
secret container during apply does not revoke upstream clients/devices; preserve unrelated
nodes and retained workspaces. Managed tunnels add another vendor/credential plane;
provider-native proxies lack a common GCE/Docker contract. A dedicated gateway is justified
only by measured constraints, not initially. Public unauthenticated sharing is out of scope.
