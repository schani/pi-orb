# Live orb files

**Approved 2026-11-05, PST; not deployed.** Question 90 in `docs/open-questions.md` records approval and exposure risks. [Approved proposal](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/08059a1f-04fb-4ca2-907f-e38b2140e180/proposals/orb-files.html).

## Address and access

`https://f-o<canonical-orb-uuid>.piorb.live/workspace/repo/report.html` names an absolute guest path; percent-encode each segment. Immutable orb UUIDs select targets on separate per-orb origins using existing wildcard preview ingress. `/__pi_orb/*` is reserved for authentication; all other file-host paths bypass application routing.

Browser access reuses preview login and host-only sealed cookies but admits only the target owner, not coworkers. Machines use existing `pi-orb id-token --audience urn:pi-orb:access` credentials via `x-pi-orb-token`; verified callers must share the target owner, including across projects. No public access, URL credentials, grants or CORS.

Ordinary readable files anywhere on isolated guests are exposed using the agent's filesystem permissions, including secrets and tmpfs files. Reject symlink components, special files, `/proc`, `/sys`, `/dev` paths and proc/sys filesystem aliases; validate the opened descriptor. Host-process providers expose only the canonical `PI_ORB_WORK_DIR` workspace (including repo, home and uploads), never the rest of the host filesystem. Missing workspace configuration fails closed. This is neither a hostile-filesystem sandbox nor an atomic snapshot.

**Accepted risk:** active HTML can fetch and exfiltrate readable same-orb credentials using the browser cookie. Per-orb origin isolation protects the app and other origins, not files within that orb; same-owner machine access also spans secret files and projects.

HTML renders inline; text and relative web assets receive appropriate MIME types. Responses use `no-store`, `nosniff`, `no-referrer` and no CORS. Reject service-worker script requests. No directory listings, generated indexes, search or writes.

## Local development

With the local-auth control plane on port 3000, set `PI_ORB_PREVIEW_ORIGIN=http://preview.localhost:3000`. Local-auth mode uses its development identity; no token is required. The existing process provider requires Linux.
The base URL is `http://f-o<orb-uuid>.preview.localhost:3000`; append the percent-encoded **absolute canonical host workspace path**, not `/workspace` or a repo-relative path.
Browsers resolve `*.localhost` to loopback without DNS registration. Outside-workspace paths return 403; symlinks remain forbidden.
Other machines and cloud orbs cannot reach your localhost. CLI/Node DNS may not resolve these names automatically; for percent-encoded absolute `$FILE_PATH`:
`HOST=f-o$ORB_ID.preview.localhost; curl --resolve "$HOST:3000:127.0.0.1" "http://$HOST:3000$FILE_PATH"`
This is local access, not global sharing; use `pi-orb host` for durable publication.

## Read path and lifetime

Ingress → control-plane owner/readiness admission → authenticated runtime transport → GET/HEAD `/v1/files?path=<encoded-absolute-path>` → filesystem adapter. Each layer calls its immediate neighbor; no exec/base64, object storage, preview registration or new persisted state.

Authorize ownership and current running incarnation at **request admission only**; the private runtime verifies its bearer, incarnation header and readiness. No file-specific lifecycle watchers, capacity accounting, polling, lease, auto-start or keep-awake. Normal runtime stop/disconnect terminates streams; an admitted read has no synchronous revocation guarantee.

Use standard bounded, backpressured streams with cancellation and one request-wide deadline covering admission and streaming, capped at 120 seconds and authentication expiry. Abort after-header failures rather than reporting clean EOF. File bytes never enter agent WebSocket frames or history; failures use typed HTTP statuses.

Links show current bytes at a stable URL. Missing file/orb returns 404; stopped/unavailable compute returns 503. Browser errors preserve the URL, identify the resource and link to the dashboard; machines receive typed errors. Guest deletion removes availability. `pi-orb host` publishes durable copies available offline or after archival (`docs/hosting.md`).

## Agent guidance and qualification

Trusted configuration supplies the canonical files base URL to shared environment prompts for both harnesses and child conversations. Claude's authenticated boot context includes optional `filesBaseUrl: string` only when serving is configured; central Pi uses the same configured URL. Unconfigured deployments omit live-file guidance. Approved wording links prose references with per-segment encoding and leaves code/command paths unchanged. No transcript rewriting or new tool.

Failures and recoveries use deduplicated durable lifecycle edges with target and typed status; healthy reads stay quiet. Exclude file hosts from infrastructure access logs; never log raw paths, queries, tokens or content.

Tests cover admission/authentication, origin/path isolation, filesystem restrictions, bounded streaming and cancellation, no registration/start/lease, and actual HTML with relative assets through both runtime harnesses. Browser navigation waits for the exact target's non-3xx main-frame response, not `page.goto()`'s intermediate login-handoff HTML response.

Rejected: app/common origins weaken isolation; per-file publication defeats live access; per-link grants, snapshots and lifecycle machinery add unnecessary state.
