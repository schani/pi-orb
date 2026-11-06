# Live orb files

**Implemented locally and live-verified 2026-11-05, PST; not deployed to production.** Pre-integration compact-link qualification was focused, on then-uncommitted source over `87864990`; the full-suite evidence below is historical pre-compact evidence. Questions 90–93 in `docs/open-questions.md` record approval and exposure risks. [Approved proposal](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/08059a1f-04fb-4ca2-907f-e38b2140e180/proposals/compact-orb-links.html).

## Address and access

### Fixed files origin — approved 2026-11-05, PST

Use existing fixed `PI_ORB_HOSTING_ORIGIN`, **not appOrigin**: `/files/<canonical-orb-uuid><encoded-absolute-path>`. Encode segments, preserving `/`. Orb identity appears only in the path; no per-orb hostname or port, per-file publication or new state. `/s/…` remains durable hosting. Relative assets resolve normally.

Browser access admits only the target owner, not coworkers. Machines use existing `pi-orb id-token --audience urn:pi-orb:access` credentials via `x-pi-orb-token`; verified callers must share the target owner, including across projects. No public access, URL credentials, grants or CORS.

**Any HTML anywhere on this shared origin—including published `/s/…` copies—can read/exfiltrate all live files the signed-in owner can read, across orbs and projects.** Paths provide no browser isolation. Keep the app separate with exact-origin checks. Files allow only authentication and hosted/live GET/HEAD: no app APIs, WebSockets or CORS. Block live service-worker script requests; the existing hosting origin may already have installed workers.

Preserve the service chain, owner/token/target checks, incarnation admission, workspace confinement, filesystem restrictions, expiry, bounded streaming and telemetry below. Replacement includes hosting admission, login return paths, machine-token path gates and live gateway/URL generation—not configuration alone. Enforce the files-only allowlist before app routing.

Ordinary readable files anywhere on isolated guests are exposed using the agent's filesystem permissions, including secrets and tmpfs files. Reject symlink components, special files, `/proc`, `/sys`, `/dev` paths and proc/sys filesystem aliases; validate the opened descriptor. Host-process providers expose only the canonical `PI_ORB_WORK_DIR` workspace (including repo, home and uploads), never the rest of the host filesystem. Missing workspace configuration fails closed. This is neither a hostile-filesystem sandbox nor an atomic snapshot.

HTML renders inline; text and relative web assets receive appropriate MIME types. Responses use `no-store`, `nosniff`, `no-referrer` and no CORS. Reject service-worker script requests. No directory listings, generated indexes, search or writes.

## Development access

Local defaults use `http://files.localhost:7100/files/<orb-uuid><encoded-absolute-path>`. With the process provider, append the **absolute canonical host workspace path**, not `/workspace` or a repo-relative path. Workspace confinement and symlink rejection still apply. The process provider requires Linux. `*.localhost` points at the reader's machine, so these links cannot share a cloud development backend.

**Process-host finding (2026-11-05, PST):** `/workspace/repo/README.md` returned 403; the actual canonical host-workspace path returned 200. The agent assumed a root despite earlier correct `pwd`; runtime cwd/configuration and the guard were correct ([approved prompt amendment, question 92](open-questions.md#canonical-path-prompt-guidance--92)).

For development inside an outer orb, use two fixed public previews registered at startup with the existing preview tool:

- Port **7100**: the existing app/control-plane listener. Set `PI_ORB_APP_ORIGIN` to its actual returned preview origin.
- Port **7101**: a TCP forwarder to 7100, preserving the external **Host**, path/query and streaming/cancellation. Set `PI_ORB_HOSTING_ORIGIN` to this port's actual returned preview origin. Fastify listens on loopback port 7100; the files-only allowlist selects by Host.

Run the existing `socat` binary on loopback:

```sh
socat TCP4-LISTEN:7101,bind=127.0.0.1,reuseaddr,fork TCP4:127.0.0.1:7100
```

These are two origins for the whole development control plane, not one port per inner orb or file. Retrieve registered URLs; never construct preview URLs. No `PI_ORB_PREVIEW_ORIGIN` is needed for live files.

Authentication has two boundaries (`docs/ports.md`): production preview login or a production-issued orb access token admits the **outer** orb's registered port. Inner `PI_ORB_AUTH_MODE=local` then uses its fixed development identity, not the outer caller's identity. Admitted coworkers can reach outer previews and therefore act as that same inner developer; inner owner-only checks do not distinguish them. This is authenticated preview access, not public anonymous sharing or an end-to-end owner-only guarantee. The outer preview's activity lease and stream limits still apply; the inner file read adds none.

Outer previews strip platform headers/cookies, including `x-pi-orb-token`, before forwarding. A production token authenticates only the outer gateway; an inner development issuer's token is not trusted there. Parent validation passed browser and production-token outer admission → inner fixed-local file reads. This does not propagate machine identity across layers. Inner-issuer distrust and coworker access as the fixed developer remain source-known limitations; a separate-user live run is not claimed.

**Cloud-development acceptance (2026-11-05, PST):** parent-verified public app/files previews use control-plane port 33528 and a Host-preserving `socat` forwarder on 33529, without preview-origin configuration. Authenticated browser HTML, relative CSS/classic JavaScript and JavaScript fetch of live bytes passed through the public files URL. Production-issued root orb tokens admitted machine GET/HEAD (200), including encoded spaces, `#` and `%`. Anonymous reads returned 401; app API on files returned 404, files on app 403, service-worker requests 403, writes 405 and files-Origin app requests 403. Stopping the fixture made its URL return 503 without restarting compute. The explicitly named, no-repository/no-initial-message fixture was deleted: project/orb GETs returned 404 and its workspace was absent. The existing `orby` project and its stopped orb were preserved. Evidence: `.context/process-host-dev/public-machine-smoke.json`, `.context/process-host-dev/live-smoke.json`, `.context/process-host-dev/app-verification.md`.

## Read path and lifetime

Ingress → control-plane owner/readiness admission → authenticated runtime transport → GET/HEAD `/v1/files?path=<encoded-absolute-path>` (or `?base=repo&path=<encoded-repository-relative-path>`) → filesystem adapter. Each layer calls its immediate neighbor; no exec/base64, object storage, per-file preview registration or new persisted state.

Authorize ownership and current running incarnation at **request admission only**; the private runtime verifies its bearer, incarnation header and readiness. No file-specific lifecycle watchers, capacity accounting, polling, lease, auto-start or keep-awake. Normal runtime stop/disconnect terminates streams; an admitted read has no synchronous revocation guarantee.

Use standard bounded, backpressured streams with cancellation and one request-wide deadline covering admission and streaming, capped at 120 seconds and authentication expiry. Abort after-header failures rather than reporting clean EOF. File bytes never enter agent WebSocket frames or history; failures use typed HTTP statuses.

Links show current bytes at a stable URL. Missing file/orb returns 404; stopped/unavailable compute returns 503. Browser errors preserve the URL, identify the resource and link to the dashboard; machines receive typed errors. Guest deletion removes availability. `pi-orb host` publishes durable copies available offline or after archival (`docs/hosting.md`).

## Compact Markdown URIs — implemented contract 2026-11-05, PST

**Implemented and locally qualified.** Compact links and the exact shared guidance below were approved on 2026-11-05, PST (question 93 in `docs/open-questions.md`).

`orb:README.md` resolves against the configured initial repository (`PI_ORB_WORK_DIR/repo`); `orb:/actual/absolute/path` uses an actual path, never a virtual/workspace alias. Encode segments. The runtime files boundary resolves repository paths, not `process.cwd()`.

A single slash marks an absolute path; `//` authority syntax is unnecessary because these links have no authority.

Transform Markdown AST inline/reference/explicit-autolink destinations using the viewed orb and optional derived `OrbView.filesBaseUrl`, never app origin. This response field derives from existing configuration and orb identity; it is not persisted state. Leave raw history/code untouched. Reject malformed/authority-bearing forms after CommonMark destination normalization; a raw literal `%` normalizes to `%25` (a filename), without a custom remark walker. Images/bare autolinks are out of scope. Other schemes retain sanitization.

Keep canonical absolute HTTP `/files/<uuid><ABS>`; add noncolliding `/files/repo/<uuid>/<relative>`. Relative assets stay on their branch. Preserve service layering, authorization/token targeting, incarnation admission, filesystem guards, lifetime, streaming, telemetry and shared-origin exposure.

Raw URIs require originating-orb context, not global sharing. Copy HTTPS links; machines use actual URLs with existing id-tokens. No persisted state, metadata endpoint, redirect service, protocol handler or new tool.

**Exact approved shared guidance:**

> When referring to an orb-local file in prose, use a Markdown link with `orb:<repository-relative-path>` (for example, `orb:README.md`) or `orb:/absolute/path`. Percent-encode each path segment. Keep filesystem paths unchanged inside code and commands. Resolve absolute paths with `pwd`/`realpath`; do not assume a workspace root.

## Agent guidance and qualification

The shared environment prompt always includes the exact compact-link guidance above for Pi/Claude and root/child conversations. Repository-relative links come first; absolute links require actual paths. All supported providers configure a fixed files origin (defaulted or required), so no capability flag or boot-context URL is needed. Rendering derives the HTTP destination from the viewed orb's metadata; prompts need no files origin, orb UUID or physical workspace prefix. No transcript rewriting or new tool.

**Canonical-path rationale (2026-11-05, PST):** the agent previously assumed `/workspace/repo` despite earlier correct `pwd`. Question 92 required canonical-path guidance; question 93 retains that requirement for absolute paths while adding repository-relative links. Canonical workspace confinement remains unchanged, without aliases or remapping.

Failures and recoveries use deduplicated durable lifecycle edges with target and typed status; healthy reads stay quiet. Exclude the fixed files origin from Cloud Run request-URL logs before service activation (`infra/hosting.tf`); edge/custom/ancestor sinks require separate verification. Never log raw paths, queries, tokens or content.

Tests cover admission/authentication, origin/path isolation, filesystem restrictions, bounded streaming and cancellation, no registration/start/lease, and actual HTML with relative assets through both runtime harnesses. Browser navigation waits for the exact target's non-3xx main-frame response, not `page.goto()`'s intermediate login-handoff HTML response.

**Historical pre-compact qualification (2026-11-05, PST):** focused checks (89 unit, seven infrastructure), typecheck and lint passed; Sol approved one frozen-behavior review round without findings. Actual-file browser E2Es passed for process workspaces and both Docker harnesses (Pi execution and native Claude), including owner login, relative assets and same-owner cross-project id-tokens. Full `npm test` exited 0: 6,258 passed / 43 skipped unit checks, plus 156 Node infrastructure, 262 Python infrastructure and 34 native-VM checks. Full `npm run test:e2e` exited 0: 660 passed / 12 skipped checks, 72 passed / 3 skipped files. These qualify frozen uncommitted behavior on `87864990` before the question 92 prompt amendment and question 93 compact-link implementation, not the current working tree, a new committed HEAD, later-source runtime image or production deployment. Evidence: `.context/orb-files/path-validation/implementation-report.md`, `npm-test-complete.log`/`.exit` and `e2e-full.log`/`.exit`. Release checks remain in `TODO.md`.

**Compact prompt slice (2026-11-05, PST):** tests first failed on the unchanged guidance/boot contract (eight expected assertions), then passed all 136 focused prompt, Claude composition, boot client, runtime-route and protocol tests after the implementation. Root/child Pi and Claude composition assert the exact approved wording without live HTTP prefixes or deployment metadata. Evidence: `.context/orb-files/compact-implementation/prompt/`. This prompt-only slice preceded the integrated focused qualification below; it did not qualify deployment.

**Current focused qualification (2026-11-05, PST):** 460 unit tests / 23 files, root typecheck/lint and the immutable web build passed. Final process/browser checks passed 3 with 2 intended Docker-only skips; fresh Docker checks passed 6 with 1 intended process-only skip, including all four full-slice first-message cases and actual Pi/Claude file cases. Three Sol review rounds approved backend/prompt, frontend and the corrected exact-RGB CSS assertions. Approved source/build checksums and final logs: `.context/orb-files/compact-implementation/final/qualified/`; reviews: `.context/orb-files/compact-implementation/sol-loop.md`. These are focused working-tree gates, not current full-suite or exact-HEAD release qualification.

**Live compact-link verification (2026-11-05, PST):** the actual development backend restarted with the immutable compact UI, not the old build. A fresh real native Sol turn, asked normally for a README link using its environment instructions (without forcing a URI), committed exactly `[README.md](orb:README.md)`. The UI rendered `/files/repo/<fixture-uuid>/README.md` on the public HTTPS files origin; a native click opened a new tab with matching real workspace bytes (200). This verifies one turn, not guaranteed model behavior. Production-issued owner tokens passed matching GET/HEAD (200); the assumed `/workspace/repo` path remained 403, files-origin app API 404, anonymous access 401, writes 405 and service-worker requests 403. After stop the repo URL returned 503 without starting compute. Fixture project/orb GETs returned 404 and its workspace was removed; both original orbs remained stopped/idle. Evidence: `.context/process-host-dev/compact-smoke.json`, `final/qualified/public-click.txt` and `restarted-dashboard.txt` under the compact implementation directory. Remaining release and untested cloud-development checks: `TODO.md`.

Rejected: per-orb origins require wildcard ingress and are awkward to share from cloud development; the user accepted shared-file-origin exposure instead. The app origin remains separate. Per-file publication defeats live access; per-link grants, snapshots and lifecycle machinery add unnecessary state.
