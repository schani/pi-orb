# Testing

The no-flake policy, DST replay requirement and the E2E gate for runtime/protocol/harness changes are in `AGENTS.md`. This doc adds how to run, the detailed rules, the DST strategy, the CI layout and the approved exceptions.

## How to run

| Command | Runs |
| --- | --- |
| `npm ci` | Install. Applies the sealed dependency patches and repairs node-pty's macOS `spawn-helper` bit. |
| `npm run typecheck` | Every workspace, then `tsc -p e2e`. |
| `npm run lint` | Biome over the repository, excluding non-shipping `design-prototypes/`; Markdown/YAML formatting stays disabled. |
| `npm test` | Root Vitest (`packages/*/src`, `apps/*/src`, `e2e/**/*.unit.test.ts`; 30 s test timeout; `maxWorkers: 50%`), then `npm run test:infra`. |
| `npm run test:infra` | Node contracts (`scripts/`, `infra/`), Python `infra/*_test.py`, `infra/native-vm/test.sh`. |
| `npm run test:e2e:install` | Lockfile-pinned Playwright Chromium + WebKit with system dependencies. Run after `npm ci` on every fresh machine, CI E2E job and release; both engines are mandatory ([postmortem](postmortems/2026-09-13-release-webkit-prerequisite.md)). A missing `libgstreamer-1.0.so.0` means this step was skipped. |
| `npm run test:e2e` | All E2E projects (`e2e/vitest.config.ts`). Add `-- --project <name>`, `--shard=N/4`, file paths or `-t`. |
| `npm run test:e2e:frontend` / `test:e2e:mobile` | Fixture-only browser subsets; no Docker. `mobile` runs `frontend-mobile` on Chromium and WebKit; `frontend` adds the shell, session, transcript-cache and sleep-icon suites. |

A full local gate runs sequentially on one runner against frozen source: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.

**E2E backend.** Default: Docker hosts and real PostgreSQL. `PI_ORB_E2E_BACKEND=process` selects process hosts and PGlite; Docker-only legs skip. Docker global setup verifies `PI_ORB_E2E_RUNTIME_IMAGE_ID` exactly, or builds `pi-orb-runtime:dev` and the preview fixture image from the current tree.

**Fake model provider.** `node scripts/local-fake-provider.mjs -- <command>` runs the pinned fake OpenAI service (worker 3210, Vite 5173) for the wrapped command and exports `PI_ORB_FAKE_OPENAI`. Without it, the harness uses `https://fake-openai.flingit.run`. Example:

```sh
PI_ORB_E2E_BACKEND=process node scripts/local-fake-provider.mjs -- npm run test:e2e -- e2e/full-slice.e2e.test.ts -t 'runs login, a scripted tool round trip'
```

Ports 3210/5173 make the wrapper exclusive per host: do not overlap it with another wrapper run or the full unit/infra suite. Its `npm ci` refuses to run unless the fixture denies `cloudflared` install scripts and npm meets the pinned minimum.

**DST replay.** A failing schedule writes `test-failures/<scenario>-<epoch>-<iteration>.json`. Replay it with the same source:

```sh
DST_REPLAY=test-failures/<trace>.json npx vitest run <test file> -t '<test name>'
```

| Variable | Effect |
| --- | --- |
| `PI_ORB_TEST_DATABASE_URL` | Runs network-PostgreSQL store contracts in the unit suite (`openThrowawayPostgres`: one schema per subject; schema privileges required). |
| `PI_ORB_DURABLE_PG_TEST_URL` | Runs real-PostgreSQL Durable storage cases. |
| `PI_ORB_TEST_HOSTING_BUCKET` | Runs the live GCS hosting cases. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Chromium binary; otherwise `/usr/bin/chromium` when present, else Playwright's managed browser. |
| `LIFECYCLE_CAMPAIGN_{FIRST_SEED,SEEDS,COMMANDS}` | Seeded lifecycle campaign range (default seeds 0–63, 96 commands). |
| `EXECUTION_CAMPAIGN_{FIRST_SEED,SEEDS}` | Execution-environment campaign range (default 0–255). |
| `CENTRAL_WORK_CAMPAIGN_{FIRST_SEED,SEEDS}` | Central-work campaign range (default 0–3; visibility mode 0–7). |
| `STUDY_OUTPUT_DIR`, `CHROMIUM_PATH` | Design-prototype browser studies; use a fresh output subdirectory. |

Campaign replay: `DST_REPLAY=<trace> LIFECYCLE_CAMPAIGN_FIRST_SEED=<seed> LIFECYCLE_CAMPAIGN_SEEDS=1 npx vitest run apps/control-plane/src/domain/lifecycle-campaign.dst.test.ts -t '<placement> seed <seed>$'` (execution campaign: `-t 'execution environment <placement> seed <seed>$'`).

**Linux / native orbs.**

- Start Docker with `sudo systemctl start docker` so it uses the configured persistent containerd store; never a bare daemon. After a restart, inspect processes and containers first: the daemon can auto-start an interrupted fixture. Preserve its data and logs ([postmortem](postmortems/2026-09-09-local-e2e-docker-startup.md)).
- Long validation runs as a tracked, detached process with a durable exit-status file. A tool-call or outer command deadline shorter than the suite is not a test result.
- Keep `TMPDIR` short: Unix-socket paths are limited to 107 bytes.
- Run tests under `umask 022`; a private `umask 077` breaks `dpkg-deb` fixtures.
- Release-script contracts require local `jq`; its absence is a missing prerequisite, not a flake.
- Fresh Docker stores must pass UID-drop entrypoint access and PostgreSQL readiness under daemon umask `022`; private parents stay `0700`, files `0600` ([postmortem](postmortems/2026-10-02-docker-daemon-umask.md)).

**macOS.**

- The process host is Linux-only; launch-dependent process-provider tests and the process-backend E2E files skip elsewhere. `scripts/local-fake-provider.test.mjs` real-process cases skip off Linux.
- Fixture temp directories are `realpath`ed (`/var` → `/private/var`).
- WebKit: Tab skips buttons (tests use Option+Tab); keyboard scrolling is animated, so hold each key until the transcript moves, then wait for three still frames; a middle-click follows the link in place (that popup step skips on darwin WebKit).
- Run long suites under `caffeinate -s`; lid sleep produced false timeouts.
- Docker Desktop under sustained E2E load can wedge: CLI calls hang past SIGTERM and port forwards die while containers run. Both Docker exec seams escalate timeouts with `SIGKILL`. Keep the failing log, then restart Docker Desktop.
- `docker-credential-desktop` can hang base-image metadata resolution. Use a test-owned `DOCKER_CONFIG` without credential helpers (keep the buildx plugin path; set `DOCKER_HOST` to the daemon socket). Never edit the user's Docker config.

## Rules

### Failures and evidence

- Preserve first-failure evidence before any fix, rerun or cleanup. A green rerun clears nothing; an interrupted, cancelled or partially selected run is neither a pass nor a failure of the unrun part.
- Failure diagnostics never make unbounded calls and never replace the original failure. A cleanup failure on an otherwise passing test fails it after remaining cleanup ran ([postmortem](postmortems/2026-09-16-e2e-fake-inference-tls-reset.md)).
- Replay must reproduce the same invariant message and first-failure origin. Retain the original error/stack/identity and the replay verdict; unexpected failures keep their traces. Expected-failure self-tests delete their own traces only after all assertions pass.
- After a fix that changes scheduling, strict replay usually diverges; say so. Fresh schedules qualify the fix, not a divergent replay.
- Keep executable regressions, concise postmortems and allowlisted CI artifacts in Git/Actions. Bulky logs and traces go to checksum-indexed downloadable archives with source revision and replay instructions ([example](postmortems/2026-09-14-subagent-qualification-evidence.md)).
- Image-export or snapshot failures invalidate qualification until a clean, explicitly owned build/store boundary exists; keep the failed parent/snapshot identities ([postmortem](postmortems/2026-09-15-docker-snapshot-validation-failure.md)).
- Setup-only stalls (APT, image pulls, runner capacity) are neither test failures nor qualification. Preserve terminal logs; separate the proven phase from unproven mirror/runner causes ([postmortem](postmortems/2026-10-22-durable-browser-apt-stall.md)).

### Qualification boundaries

- Qualify the exact source: CI checks out the PR merge commit, not the branch head. Pin the tested checkout and merge tree, not a related branch or older artifact ([postmortem](postmortems/2026-09-27-restart-notice-e2e-rule.md), [postmortem](postmortems/2026-09-27-sandbox-qualification-harness.md)).
- The required jobs, green on the first attempt for the exact source, are listed in `docs/deployment.md`. Cache hits never waive exact-head qualification.
- Freeze sources and dependency manifests before browser acceptance; edits during a Vite-backed run reload the page and void it. Qualify with fresh processes, never HMR ([postmortem](postmortems/2026-10-04-claude-poc-validation-source-changes.md)).
- One clean `npm ci` precedes validation in a shared checkout; nothing installs while another run validates. Use npm scripts or repository binaries, never an `npx` download ([postmortem](postmortems/2026-09-29-native-mcp-validation-install-race.md)).
- Heavy suites own the host: one command owner, descendants exited before the next E2E/browser phase. CPU contention can push 30 s cases over their deadline; the fix is ownership, not a larger timeout ([postmortem](postmortems/2026-10-19-image-test-cpu-contention.md)).
- Preemption-prone hosts persist completed checks and run sequential bounded groups against frozen source ([postmortem](postmortems/2026-10-04-spot-preemption-loadout.md)).
- Filtered full-slice cases are not independent: later scenarios reuse the login authorized by the first. Qualify the whole file.
- Unit contracts own stream/model/resource boundaries; executable acceptance scenarios own scheduling and effects. Manual studies, native and network probes own their own validation, bounded commands, authenticated expectations and cleanup; they do not establish live product acceptance or network causality.
- Browser cases own mounted behavior; SSR proves markup only. A test-owned Vite instance does not qualify an already-running shared preview: validate the changed operation on the served preview and inspect its reload logs; shared-protocol export changes need a full frontend restart ([postmortem](postmortems/2026-09-09-stale-frontend-preview.md)). Publishing to a running static server needs every referenced entry JS/CSS asset verified for status/MIME and actual rendering ([postmortem](postmortems/2026-10-04-claude-management-assets.md)).
- A configured URL plus localhost HTTP success does not prove external browser reachability ([postmortem](postmortems/2026-09-09-orb-local-tailnet-smoke.md)).
- Live WIF proof uses a fresh isolated credential configuration and records JWT → STS → impersonation → authorized API; cached credentials or an empty-body 400 prove nothing. If idle-stop interrupts a live fixture, keep the first failure and resume only missing legs.
- Simulations do not qualify real SDK/provider transport, PostgreSQL locks/pools, DOM/React concurrency or production incidents; say which boundary a test owns.

### Synchronization

- Use observed entry/closure barriers, never sleeps or global counts. Summary barriers match the current phase and exact orb. HTTP reads are not SSE frames; PTY execution markers differ from the input that produced them. Cancellation must reach the pending read before closure.
- Assert fallible task/adapter `Result`s (including `sim.runTasks`) and captured arguments outside callbacks that catch failures. Require successful nonempty premises before absence/order assertions; source slices require every anchor and nonempty ordered bounds.
- Assertions about cleanup run by the peer's independent callback await that callback's own signal, not the local close event ([example](../apps/orb-runtime/src/http/terminal-route.test.ts)).
- Settle gates (`scrollend`, `transitionend`, `animationend`) sample a quiescent baseline first and release only on a settle preceded by observed movement ([postmortem](postmortems/2026-09-16-terminal-shade-stale-scrollend.md)). WebKit `wheel` delivers several scroll offsets: wait for the full movement and a native scroll acknowledgement.
- Observe a held request before changing fixture lifecycle; snapshot mutable fixture state when the request enters its route; await the exact browser response before asserting its effect. A definitive history 404 is monotonic for the mounted route ([postmortem](postmortems/2026-09-18-webkit-missing-resource-race.md)).
- Pages await the fixture response that enables their assertions; navigation or a static strip is not readiness ([postmortem](postmortems/2026-09-18-hosted-frontend-bootstrap-readiness.md), [postmortem](postmortems/2026-09-18-e2e-concurrency-readiness.md)). Live controls wait for the frame that enables them ([postmortem](postmortems/2026-09-16-webkit-cache-readiness.md)); an enabled picker is not an idle barrier—wait for committed history ([postmortem](postmortems/2026-09-15-cache-catchup-fixture-ownership.md)).
- Focus-dependent styles await both enabled and focused state; focusing a disabled field is a no-op ([postmortem](postmortems/2026-09-18-hosted-frontend-bootstrap-readiness.md)).
- Absolute-scroll assertions await media and `document.fonts.ready` before sampling ([postmortem](postmortems/2026-10-05-mobile-reader-font-readiness.md)). Layout after a viewport change is asynchronous (ResizeObserver): poll the unchanged predicate. Await the transcript tail and all rendered SVGs before native clicks near them.
- Streamed output and its committed record must never coexist at an observable frame boundary; prove it with explicit checkpoints, not text matching ([postmortem](postmortems/2026-09-12-mcp-completion-selector.md)).
- Transport ownership tests require exactly one final owner and closure of superseded transports, not cumulative counts ([postmortem](postmortems/2026-09-14-terminal-retry-pre-ready.md)).
- Device-approval and similar waiters require nonempty values (code and URI), not merely non-null.
- Navigation tests wait for destination identity and `aria-busy=false`, not textarea visibility: the visible composer may still belong to the outgoing orb. Route-switch Command-K tests dispatch from a `MutationObserver` at the commit boundary.
- Find keyboard tests gate the orb-list response, assert the partial-loading state, release it, wait for the intended href and verify active selection before Enter ([postmortem](postmortems/2026-09-15-find-keyboard-navigation.md)).
- Fixture smokes wait for the initial idle snapshot before arming a completion hold, and gate before request delivery so both HTTP and live `request.result` acceptance are controlled; an enabled composer is not socket-snapshot readiness.
- Upload E2E measures chunk sizes from server-acknowledged offsets; routed Playwright requests hide browser-added `Content-Length`.

### Resource and fixture ownership

- Register each resource immediately, before fallible setup. Release gates and join processes/streams on every exit; run independent cleanup even after another release fails, preserving the primary failure. Publish synthetic readiness atomically by rename. Restore environment overrides unconditionally.
- Listeners bind port 0 and announce the owned port; never reserve-and-release. Vite's `listen(0)`/`port: 0` falls back to 5173, so frontend fixtures bind their own HTTP server through `e2e/frontend-listen.ts` ([postmortem](postmortems/2026-09-15-cache-catchup-fixture-ownership.md)). E2E control-plane readiness requires the child's listen announcement. Ingress binds before control-plane startup, preserves Host and duplex upgrades; Docker advertises `host.docker.internal` separately from browser/public origins; restart scenarios rebind the first public endpoint. Remaining fixed ports are unique per file (`multi-user-credentials` 7168, `mcp-oauth` 7179, `orb-sleep` 7181).
- E2E readiness probes overlay caller headers on the public Host default; the issuer defaults to the advertised public origin unless configured.
- Runner-side services (model relay, fences) listen on loopback; never advertise a guest-only hostname to a runner process.
- PostgreSQL E2E containers use Docker-assigned loopback ports (`127.0.0.1::5432`), record the container ID before start, and remove only that ID ([postmortem](postmortems/2026-09-15-postgres-e2e-port-collision.md)). Readiness probes TCP `127.0.0.1`, not the init-only Unix socket.
- Each harness control plane gets its own Docker inventory scope; the provider refuses cross-scope mutation ([postmortem](postmortems/2026-10-05-e2e-docker-inventory-isolation.md)). Containers carry unique test-owned names/labels; fixtures create no host veth/route changes.
- Per-file temporary roots own databases, credentials, hosting data, process-host state and web output. Full-slice PostgreSQL fixtures are execution-unique; setup never deletes a previous run's data.
- E2E orbs clone a one-commit snapshot of the checkout served by `git daemon` (`e2e/testkit/repository-fixture.ts`), not GitHub; the cross-axis Docker case keeps the real repository. The fixture belongs to the test file: `repository-fixture-setup.ts` (a `setupFiles` entry) wraps the suite in `aroundAll` `try/finally` because Vitest reverses teardown hooks and stops on rejection, and worker termination skips process-exit cleanup.
- Foreign-UID (2000) native fixtures stage sources, helpers and their dependency closure in an owned, guest-traversable temporary tree outside the checkout, HOME and TMPDIR; no `node_modules` symlink may cross an inaccessible ancestor.
- Supervisor fixtures: see the cleanup-order rules in [postmortem](postmortems/2026-10-14-supervisor-fixture-readiness.md).
- The E2E inference relay owns rejected upgrade sockets until close; only the rejected peer's `ECONNRESET` is a normal outcome ([postmortem](postmortems/2026-10-16-e2e-relay-upgrade-socket-ownership.md)).
- Release subprocess fixtures own their output paths and inherit none of `PI_ORB_RELEASE_RESULT_DIR`, `PI_ORB_RELEASE_RECORD`, `PI_ORB_USER_ID` or `PI_ORB_ORIGINAL_*`; shell contracts run with owner inputs present and separately prove the migration job gets the validated values ([postmortem](postmortems/2026-09-09-release-test-environment.md), [postmortem](postmortems/2026-09-17-release-owner-environment-leak.md)).
- Fixture credentials keep stable identity/expiry under advancing clocks ([postmortem](postmortems/2026-10-25-codex-fixture-grant-expiry.md)). Fixture clocks stay inside the other clock domains' lifetimes (a control-plane-only clock jump can expire a grant the runtime still considers valid).
- Tenant tests share storage with colliding native IDs and distinct bytes; read, replace, retire and archive must preserve the other tenant. Namespace tests require simultaneous distinct objects and independent deletion. Denied writes preserve nonempty state/revisions.
- Compare large binary payloads by explicit length plus full byte comparison (`Buffer.equals`), never `toEqual` over buffers ([postmortem](postmortems/2026-10-16-image-validation-buffer-comparator-oom.md)).

### Browser tests

- Route-owning tests unregister and drain handlers (`unrouteAll({ behavior: "wait" })`) before page teardown; interceptors preserve non-JSON/error responses ([postmortem](postmortems/2026-10-02-expired-metadata-route.md)). Playwright's raw WebSocket frame event can precede the route callback; await the callback.
- Fixture server state belongs to the server, not a page: tests that change it restore it in `finally` and check the response before closing the page ([postmortem](postmortems/2026-10-02-frontend-session-fixture-isolation.md)). Built-shell fixtures supply a typed session principal and schema-valid mocks.
- Fixture HTTP servers close each response (`Connection: close`); direct `page.request` probes send `Connection: close`. Remove pooled idle connections instead of retrying ([postmortem](postmortems/2026-10-16-usage-mock-idle-connection.md)).
- Locator visibility/stability does not prove WebKit hit testing; assert the painted hit point when it matters ([postmortem](postmortems/2026-10-04-webkit-read-drawer-hit-test.md)). Measure geometry from browser boxes, not computed CSS floats ([postmortem](postmortems/2026-09-18-image-preview-validation.md)). For SVG `<text>` in WebKit, Playwright's `boundingBox()` is offset; use the DOM rect.
- Target the intended responsive owner before focusing; Mermaid measurement stays out of flow and releases its container ([postmortem](postmortems/2026-10-23-frontend-chart-qualification.md)).
- Synthetic HTTP history that must survive belongs to a stopped fixture orb; a running fixture's full sync can erase it ([postmortem](postmortems/2026-09-27-webkit-image-fixture-sync.md)).
- The frontend fixture's DELETE returns 202 before removal finishes: teardown waits for GET 404. Archive locators name their project.
- Playwright WebKit can rerun init scripts in the same document after a navigation; make init scripts idempotent.
- Native Ctrl/Cmd-click opens a context page without an opener: wait for `context.waitForEvent("page")`. Native-tab fixtures use full Chromium (`channel: "chromium"`), not the headless shell, whose popup initialization can hide the page.
- Read styles through `toHaveCSS` or `ownerDocument.defaultView.getComputedStyle`; string-arrow `locator.evaluate` and ambient DOM globals are not available.
- Console assertions record uncaught page errors and library logger output only ([postmortem](postmortems/2026-10-13-transcript-charts-browser.md)).
- Chromium cancels queued module loads on Docker bridge/container network changes (`ERR_NETWORK_CHANGED`); this is why frontend files never overlap Docker-mutating files ([postmortem](postmortems/2026-09-18-hosted-frontend-bootstrap-readiness.md)).
- Rendered UI behavior (layout, terminal geometry, focus, scroll) is checked in a real browser; CSS contracts and SSR only pin static invariants. React StrictMode can replace imperative subtrees: assert on stable containers.
- Linux WebKit and synthetic viewport events do not equal physical iPhone/iPad behavior; physical checks are tracked in `TODO.md`.
- The frontend-only mock seeds `/orbs/frontend-mixed-tool-states` (completed, failed and running calls in one group) for manual inspection, and `/orbs/frontend-long-history` for the typing-performance regression (a test-only Vite transform counts `HistoryView` executions; gate initial live replay and inbox traffic before navigating).
- Sub-pixel layout regressions bundle their font (`e2e/fixtures/fonts/DejaVuSansMono.ttf`) so installed fallbacks cannot mask drift.

### Database tests

- PGlite shares migrations and store SQL with production but not the driver, so not parameter binding. Structured parameters declare intent with `jsonParam()`/`arrayParam()` (`apps/control-plane/src/adapters/pg/client.ts`); a shared prepare step rejects bare arrays/objects in both clients ([postmortem](postmortems/2026-08-11-orb-message-jsonb-param-encoding.md)).
- The store contract (`apps/control-plane/src/testkit/store-contract.ts`) runs on PGlite in `npm test`, on node-postgres in `e2e/postgres-store.e2e.test.ts` against `infra/postgres-test/Dockerfile` (PostgreSQL 17.11 + `pg_textsearch` 1.3.1), and from the unit suite with `PI_ORB_TEST_DATABASE_URL`.
- Raw SQL assertions select an explicit representation (`generation::text`) where drivers decode differently; typed store results stay typed ([postmortem](postmortems/2026-09-27-mcp-audit-generation-driver.md)).
- PGlite cannot establish relation-lock behavior. Locking contracts run on real PostgreSQL and observe the competing session through `pg_blocking_pids`/live lock inspection before committing; no guessed sleeps ([postmortem](postmortems/2026-10-13-history-migration-deadlock.md)).
- Search contracts require actual `EXPLAIN (ANALYZE)` use of the BM25 index with ordered `<@>` access. PGlite embeds a different extension version; it is not native parity.
- A persisted PGlite database with `pg_textsearch` preloaded is reopened through `PGliteClient`, not the raw constructor. `new PGlite(undefined, options)` ignores extension options; pass an options object (`dataDir: "memory://"`). Run both constructor variants: types do not catch the wrong overload.

### Model scripts and the fake provider

- Codex is injected by overriding `openai-codex` through `ModelRuntime.registerProvider` with custom OAuth login/refresh and the mock `baseUrl`, keeping model definitions and the wire encoder (`packages/mock-openai`). `baseUrl` alone does not redirect built-in OAuth. Never patch global fetch, DNS, TLS or installed Pi files. The override activates only when `PI_ORB_FAKE_OPENAI_OAUTH_URL` and `PI_ORB_FAKE_OPENAI_INFERENCE_URL` are set; compute receives neither; production never registers it.
- Inject credential storage and `allowModelNetwork: false`: otherwise login triggers a catalog sweep that can stall the device flow.
- Only the OAuth and inference endpoints are test-owned; Pi's real provider serialization and stream parsing run. Mock responses are valid SSE preserving response/item/tool-call identity (an echo server does not qualify the parser); fake JWTs keep the account claim Codex serialization needs.
- The mock consumes rules forward. Scripts follow actual request order, including every asynchronous Luna (naming, summary, notification) consumer; gate advancement on a recorded-request predicate, never elapsed time ([postmortem](postmortems/2026-09-09-upload-e2e-script-order.md)). Luna naming uses a separate fake session (`PI_ORB_NAME_INFERENCE_URL`). Select requests by fresh request IDs and execution order, not the mock's newest-first list.
- Matchers for runtime-generated notices are checked against the planner's actual output ([postmortem](postmortems/2026-09-27-restart-notice-e2e-rule.md)).
- Harness control requests go through `fakeRequest` (`e2e/harness.ts`): 15 s deadline; three attempts with 250/500 ms backoff for transport failures only; a returned HTTP response is never retried; only replay-safe writes (device approval of a test-owned session) retry ([postmortem](postmortems/2026-10-08-e2e-device-approval-timeout.md)).
- The E2E relay holds the marked model response's completion until a public reasoning patch acknowledges the accepted operation ID; unrelated requests continue.
- MCP E2E waits for registry publication (`test_registry_published`, emitted only under `PI_ORB_E2E_HISTORY_INSPECTION=1`) after auth approval and before the first scripted MCP input.

### CI diagnostics

- Failure artifacts are allowlisted, content-free and test-owned: `test-failures/*.json` traces and named per-fixture directories (`profile-login`, `full-slice-upload`, `missing-orb-*`, `lazy-return-*`, `orb-alert-*`, `cross-axis-*`, `full-slice-orb-*`, …), 14-day retention, names carrying shard/run/attempt. Never upload workspace/auth trees, raw request/history bodies, prompts, tool arguments or credentials. Infrastructure contracts (`infra/browser_evidence_test.py`, `e2e/sharding.unit.test.ts`) pin the allowlists.
- Profile-login/upload diagnostics record probe timestamps, HTTP status/error category, state, challenge/token presence (booleans only), replicated tool metadata and cursor, and allowlisted request-ledger fields.
- MCP failures write sanitized `test-failures/mcp-<uuid>.json` with content-free inference route counts; retain mock ledgers before their 24-hour expiry.
- Research public sources in a separate public-only cache; parse private plans in memory and emit only allowlisted facts ([postmortem](postmortems/2026-11-06-private-plan-output.md)).

## DST strategy

[`determined`](https://www.npmjs.com/package/determined) supplies cooperative scheduling, reproducible entropy, failpoints, blocking primitives, deadlock detection and exact record/replay. pi-orb needs no timed mutexes: it coordinates through database CAS, explicit lifecycle state, serialized mutation queues and cancellable adapter operations.

### Boundary

- Each application's `domain/` is the simulation boundary. Domain code imports only `determined`, `neverthrow` and first-party interface types; state machines take `(task, clock, deps)`. Fastify handlers and UI are thin folds tested conventionally.
- The control plane owns one test kit (`apps/control-plane/src/testkit/`): in-memory repository, host-provider and runtime-client fakes with latency/failure injection and named failpoints. Its acceptance test is the concurrent-poller race.
- Production uses `noSimulation`; tests run the same code with controlled scheduling.
- DST complements unit, database, Docker, browser and live tests; it does not replace adapter qualification.
- Compose the invariant's real boundaries: separate task owners, shared remote state, effects accepted independently of response delivery, forced critical interleavings ([postmortem](postmortems/2026-09-05-tailscale-invalid-key-at-first-boot.md)).
- When a design accepts a residual risk on an operational assumption ("the drain is short", "the next pass heals it"), measure it in the field or model it adversarially in DST before the acceptance stands ([postmortem](postmortems/2026-08-06-rollover-repair-war-corrupt-image.md)).
- Test the shipped artifact: build/push boots the image it pushes. Infrastructure crash-consistency is outside DST; it is covered by durable observability that outlives the host.

### Targets

Repeated/delayed history pulls; runtime or database failure before a poll commit; crash before/after commit; overlapping pollers on one cursor; records completing between pulls; history load versus live subscription; parents arriving after children; controlled stop versus new output; liveness/readiness racing stop/restart; integrity failure or runtime restart mid-drain; provider retries and recovery after partial failure; shared OAuth device flows; project-secret writers versus boot snapshots and deletion (`docs/credentials.md`); multiple reconcilers, including different configuration generations (`mixed-generation.dst.test.ts`); concurrent input and turn admission preserving operation/receipt identity; hosting publication/retirement (`domain/hosting.dst.test.ts`); workspace uploads (`domain/workspace-uploads.dst.test.ts`); inbox provenance, FIFO, replay and Stop/sleep/replacement/deletion fences (`docs/inbox.md`); MCP OAuth code/refresh ownership (`docs/mcp.md`); the Luna turn-summary coordinator (detached inference, later turns accepted while summaries pend, errors consumed without agent/runtime mutation). Browser Notification API behavior is an ordinary adapter test.

Inbox delivery crash windows are pinned in `apps/control-plane/src/domain/lifecycle.dst.test.ts` (`delivery-crash-*`, `two-dispatchers-one-delivery`, `send-versus-stop`, `idle-stop-versus-send`, `idle-stop-message-race`, `stale-wake-intent-resurrection`, `backstop-honors-any-wake-message`, `fifo-across-runtime-boot`, `note-after-replication-commit`) using `FakeRuntimeClient` partial deliveries (`crash_before_enqueue`, `enqueue_without_persist`, `persist_without_ack`). All assert, against both the runtime session and the replica: one replicated record per delivered batch, each message ID delivered exactly once, nothing lost, FIFO, no second turn. `apps/web/src/pages/outbound.dst.test.ts` composes the real outbound writer and reducer under scheduled single-frame drains.

Not every layer is a target: for two-store features (PostgreSQL + secret store), DST owns concurrent mutation, cross-store crash windows and failpoints, and must model non-atomicity honestly (e.g. an orphaned secret version that deletion later removes).

### Required properties

1. Many entropy-driven schedules and failpoint combinations.
2. Full entropy trace and configuration saved on failure.
3. The saved trace reproduces the same failure.
4. Replay is one test command.
5. Assertions are invariants, not happy-path outputs.

Core invariants: no cursor advance without its commit; stable native record IDs across pulls; no omitted complete records and no incomplete ones; idempotent retries; no host stop after a retryably failed pre-stop pull; at most one authoritative host per orb; no transition from failed health straight to idle stop.

Expectations are authored semantic facts (ordered records, ancestry, receipts, tool identities), never reducer/projector output. Detail expectations use explicit API identities, not private key encodings. Poll receipt expectations derive from modeled guest acceptance, not replica contents. Mutation failures show sensitivity, not specification validity.

### Timing

- Periodic waits use cancellable deterministic sleeps. In-process durations use `monotonicNow()`; restart-stable deadlines derived from `state_changed_at` compare against `wallNow()`.
- Each finite I/O operation runs through a deadline helper passing an `AbortSignal` to the adapter and cancelling its timer on settle. Never `await` a signal directly; never leave a `Promise.race` loser running unobserved.
- The timer policy fires deadlines late. A scenario whose invariant is not about timeouts sets `lateTimerProbability: 0` or isolates the unrelated timer; deadline behavior has its own scenarios. Never assume a healthy operation succeeds within N attempts while late timers are on.
- Establish a scenario's premise in a separate setup phase through the store boundary rather than racing product timers. Scenarios holding an orb `running` must simulate activity or disable idle-stop (`idleStopAfterMs`), and must run the poll loop: successful pulls are the only liveness signal.
- Hand-driven scenarios push grace/idle/drain windows far beyond any late-deadline leap. Do not assert state completeness after aborting tasks at an arbitrary point; assert from the log or after an explicit controlled-stop drain.
- One `SimulationTask` is one sequential coroutine; never share it across concurrent orb reconciliations ([postmortem](postmortems/2026-08-08-serial-reconciler-head-of-line-blocking.md)).
- Native promises bridging into the scheduler need a simulated owner task that stays schedulable until the completion predicate holds.
- `runDst` hands control to the host loop between completed iterations so Vitest's worker RPC is not starved ([postmortem](postmortems/2026-09-26-unit-worker-rpc-timeout.md)). It accepts the test `signal` and starts no schedule after a timeout.
- Restart phases use fresh single-use simulations through `nextPhase`, sharing recorded entropy, options and lifecycle capture; only the wall-clock epoch may change.
- Run once only where recorded traces contain no entropy or timer events. Ownership, failpoint, process/EOF and deadline races keep schedule exploration.

### Fake world

`FakeWorld` (`testkit/world.ts`) models one slot per orb; physical uniqueness belongs to provider contracts.

- A host observes `running` when its start completes but serves nothing until `bootLatencyMs` (65 s, every scenario) has passed; a booting runtime is indistinguishable from a dead one ([postmortem](postmortems/2026-08-05-unreachable-restart-livelock.md)).
- `seedRunningOrb` fast-forwards only the seeded host's initial boot.
- `preemptHost` models a Spot soft-off: the runtime goes dark at once, the instance reports `running` for a soft window (30 s) and then `stopped`; an intervening stop/start overrides it.
- Test constants keep `boot latency < postRestartGraceMs, unreachableBootDeadlineMs < createStartDeadlineMs`, as in production.
- The GCE model reserves an insert's name and exposes its metadata at acceptance; polling advances status only.
- Adapter DSTs inject command-log persistence as well as execution and clocks; model resource state outlives its creating task; an idle checkpoint-only observer must not block virtual time ([postmortem](postmortems/2026-09-09-native-cleanup-dst-io.md)).
- Ended fake queues cannot prove a production identity fence. Recovery requires a healthy post-fault state, not merely outage safety.

### Lifecycle log

`LogCapture` (`testkit/sim.ts`) is the simulation logger; it keeps only `lifecycle:` lines, resets per iteration and per scenario (not per phase). Tests assert both what must appear (recovery transitions, refusals, idle-stop reasons) and what must not (a healthy orb logs nothing; a blocked drain logs one line per episode); see `docs/lifecycle.md`. Assert telemetry after successful tasks in each iteration.

### Campaigns

- **Lifecycle** (`lifecycle-campaign.dst.test.ts`): two concurrent callers with independent compute/history workers over generated histories. A commit ledger tracks admission order, provenance, Sleep deadlines and revocations independently of responses; every still-authorized input requires a durable receipt and replicated delivery. Fair quiescence joins actors, removes faults and budgets remaining deadlines.
- **Execution environment** (`execution-environment.dst.test.ts`): generated store faults, guest health, reachability, Stop/Start/Sleep, time and controller replacement over host and central placements. Terminal health is absorbing per incarnation; accepted intent is tracked independently; drainable environments must converge to ready execution or terminal disposition.
- **Central work** (`central-work-campaign.dst.test.ts`, `testkit/central-work.ts`): real Durable plane/Harness over retained SQL, with generated programs, SQL-blind database stalls and committed-visibility delays. Programs are generated before execution; inspected state never selects commands or faults. An independent acceptance ledger requires successful terminal work under original IDs.

Shared PG/memory contracts own atomic ownership, retry identity and Sleep FIFO; native fixtures own admission gaps; campaigns own orchestration and input/receipt conservation. Effect censuses and exhaustive command catalogs are rejected: they add no invariant.

### Runtime fixtures

`ComposedClaudeFixture` (`apps/orb-runtime/src/testkit/claude-composed.ts`) keeps Claude journals in an in-memory `HistoryFiles` map; CLI transcripts, temp directories and the idle-stop fence stay real files. `apps/orb-runtime/src/claude/history.test.ts` covers real files and fsync.

## E2E and CI layout

### E2E projects

| Project | Pool / order | Files |
| --- | --- | --- |
| `frontend` | threads, first | `*-frontend`, `frontend-*`, `transcript-cache-*`, application-auth, hosting-security and fixture-only files |
| `process` | forks, second | process-backend files (Durable, full-main-auth, MCP OAuth, multi-user, alerts, sleep, idle-stop) |
| `provider` | forks, third | full-slice, cross-axis, preview Docker/central/access-token, live-files; Docker global setup |
| `postgres` | forks, fourth | `postgres-store` |

Every project has `maxWorkers: 1`; frontend browsers never overlap Docker network changes. `e2e/vitest-config.unit.test.ts` runs the actual config to prove ordering and single-file concurrency; Vitest 4+ ignores `poolOptions` and defers isolated `groupOrder: 0` files, hence orders start at 1 ([postmortem](postmortems/2026-09-27-vitest4-e2e-ordering.md)). `e2e/sharding.unit.test.ts` derives each project's inventory and requires four nonempty, disjoint, complete shards. Test and hook timeout: 720 s.

### Workflows

| Workflow / job | Runs | Budget |
| --- | --- | --- |
| CI `checks` | Artifact guard; OpenTofu foundation checks (`infra/foundation/test-tofu.sh`); typecheck; lint; `npx vitest run --maxWorkers=1 --no-file-parallelism` with both PostgreSQL URLs against a PostgreSQL 17.11/`pg_textsearch` container; `npm run test:infra` | 45 min |
| CI `control-plane-image` | After the tracked-artifact guard and a 15 GiB free-disk check, builds the control-plane image; boots its real ENTRYPOINT/CMD with network `none` and checks `/health` and the startup phase sequence (`scripts/control-plane-startup-smoke.mjs`); proves the packaged bounded worker, pinned Git and bundled skills offline (`scripts/control-plane-image-proof.mjs`) | 30 min |
| E2E `E2E (N/4)` | Docker backend: `--bail 1 --project frontend --project provider --project postgres --shard=N/4` under the local fake provider | 60 min |
| Durable `Central process (N/4)` | Process backend: `--bail 1 --project process --project provider --shard=N/4` under the local fake provider | 60 min |

All run on `ubuntu-24.04` with the pinned Node, for pull requests and pushes to `main`; `fail-fast: false` keeps other shards' evidence. PR qualification uses no cloud credentials. Deployment is separate (`docs/deployment.md`).

- Runners reclaim only the unused preinstalled Android root (`infra/runner_disk.py`) before downloads; the 15 GiB free-space guards before builds are unchanged and never waived ([postmortem](postmortems/2026-11-04-ci-runner-disk-budget.md)).
- Every Ubuntu job (CI, E2E, Durable, release) runs `infra/runner_apt.py` before its first APT operation: it points the mirror list at the official HTTPS Ubuntu archive and writes `Acquire::ForceIPv4 "true";` to `/etc/apt/apt.conf.d/99pi-orb-force-ipv4`. A system drop-in also covers Playwright's privileged APT child; per-command flags would not. Signatures, hashes and retry budgets are unchanged; URI/keyring/IPv4 diagnostics go to Actions logs. The workflow-order contract covers each job ([postmortem](postmortems/2026-10-07-runner-apt-timeout.md), [postmortem](postmortems/2026-10-14-runner-apt-ipv6-unreachable.md), [postmortem](postmortems/2026-10-22-durable-browser-apt-stall.md)).
- Browsers: `npm run test:e2e:install`, then CI exports `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to the lock-bundled Chromium, aliases `/usr/bin/chromium` and logs its version ([postmortem](postmortems/2026-10-29-pg17-ci-qualification.md)). Browser acceptance qualifies the managed revisions, not a system Chromium.
- The E2E runtime image builds once per runner with pinned Buildx actions and loads locally as `pi-orb-runtime:dev` (10-minute bound; source SHA and image ID in the step summary; no registry publication or credentials). Global setup requires that exact image ID and fails without fallback. GHA layer caching was rejected: a fully cached shard spent its whole budget materializing lazy remote layers. Workflows cache npm data and Playwright browsers (OS + lockfile), never test output or credentials.
- Durable provenance and failure-evidence uploads get one retry (five-minute deadline each, `overwrite: true` only on the retry); a retry failure fails the job and never clears a test failure.
- `fakeRequest` unit tests and other harness logic run in the root suite through `e2e/**/*.unit.test.ts`.

### Coverage owners

- **`e2e/full-slice.e2e.test.ts`** (Docker or process): device login through the mock, a scripted turn running real bash, streamed reasoning/tools, a real PTY, replication verified in the database, Luna naming, controlled-stop drain, sibling CLI discovery/transcript, self-archive and project deletion; prompt durable failure for an inaccessible repository; injected boot failure with retained workspace, boot-hook order/environment/status (`docs/orb-setup-hook.md`) and explicit higher-incarnation replacement; immutable host-spec replacement and the lower-generation decline; restart notices; spawning through the installed CLI (`docs/inbox.md`); uploads (binary + sidecar, one inbox message). Negative assertions request three reconciliation passes over IPC and await completions at or after the requested scheduler generation. Real deletion quarantine (65 s) and polling still run on real clocks.
- **`e2e/durable-process.e2e.test.ts`**: central Durable Pi on the process app with PGlite, scripted inference, authenticated HTTPS MCP and Chromium: code-mode remote tools, FIFO-gated children, native orb tools, reconnect and stop/start.
- **Subagents** (`docs/pi.md`, `docs/claude.md`): native Durable contracts and DST own root/child admission vs cancellation, terminal vs parent input, steering, receipt/publication failure, stale ownership and Stop/Start/archive; `subagent-wait.dst.test.ts` covers atomic acquisition, parallel observers, terminal precedence and caller cancellation. Browser E2E proves child-only busy, authorized broker/MCP tools, reconnect, abort and retained root outcomes without exposing private child history.
- **MCP** (`docs/mcp.md`): DST for broker authorization, generation fencing, lost writes and lifecycle races; installed-SDK transport/auth contracts; browser/runtime E2E. Fake HTTPS success is not provider qualification. MCP E2E excludes desktop notifications; best-effort Luna summaries must neither gate assertions nor consume the forward-only script, so the relay answers the exact summary request locally (`localSummaries`) ([postmortem](postmortems/2026-10-08-mcp-summary-missing-request.md)).
- **Activity headlines** (`docs/activity-headlines.md`): `activity-headlines.dst.test.ts` runs each POST as an independent task (request lifetime, cancellation/expiry, deletion/session fences, same-key publication; retry campaigns disable late timers to reach backoff); the shared store contract covers memory/PGlite/PostgreSQL; four Chromium/WebKit cases gate transport and clock and drain held routes on teardown ([postmortem](postmortems/2026-10-08-headline-spa-cancellation-fixture.md)).
- **Agent settings** (`docs/agent-context.md`): real SDK contracts (save/reopen, restoration through compaction/restart, capability holes, failures); one composed DST over request registry, admission guard, agent, sync and browser reducer with checkpoints around every claim, append, publication and hello; E2E asserts the actual mock request's model/reasoning and restoration after Stop/Start.
- **`e2e/full-main-auth.e2e.test.ts`**: actual `main()` in Google mode with signed fake-Google transport only. Node fetch ignores a supplied `Host` header.
- **`e2e/application-auth.e2e.test.ts`**: production auth/cookie/route/host-guard code against owned HTTPS origins with a fake Google issuing real signed tokens and browser redirects, never injected principals. App and files need distinct cookie hosts and the provider a cross-site host; separate localhost ports are insufficient. A test-owned CONNECT proxy routes only the owned authorities to loopback; requires OpenSSL; no hosts-file, DNS or global TLS changes.
- **Compute replacement** (`docs/lifecycle.md`): the E2E-only `PI_ORB_E2E_LAUNCH_FAILURE_MARKER` seam (never a production route) makes one exact orb/incarnation report terminal `e2e_launch_failure` and stays armed for it, so restart cannot heal suspect compute. Assert "untouched" on compute identity (container ID; process group leader plus port), not incarnation number. Every bounded wait dumps orb row, provider inventory and control-plane log tail on first timeout.
- **Project secrets** (`docs/credentials.md`): process-provider E2E proves setup cannot see a secret, resume/agent/terminal can, a hook cannot shadow it, browser metadata never returns it, it survives replacement and stop/start, and project deletion finalizes only after secret cleanup. Rotation races belong in DST.
- **Preview** (`docs/http-exposure.md`): `preview-auth-frontend` (real login/handoff on owned HTTPS origins), `preview-composed-frontend` (production gateway/HMAC forwarding with fakes), `preview-docker` (Linux `--network none` with owned Unix bridges; Docker Desktop loopback TCP + `host.docker.internal`; skipped on process), `preview-central`, `preview-access-token`.
- **`e2e/frontend-web-shell.e2e.test.ts`**: production-built assets through the Fastify shell: deep links, reload, manifest, icons, missing-resource 404s. Vite alone cannot qualify that server.
- **`e2e/frontend-session.e2e.test.ts`**: expired-session ribbon, same-tab sign-in, path and draft restoration.
- **`e2e/frontend-mobile.e2e.test.ts`**: phone/tablet cases in both engines, including visual-viewport injection and zero scroll writes during polls. Mobile WebKit rejects wheel input; that case uses the desktop backend at phone width.
- Real PTY behavior, hosting (`docs/http-exposure.md`), workspace uploads (`docs/workspace-uploads.md`) and native Claude SDK contracts (`scripts/claude-sdk-contract/README.md`: isolated HOME, dummy credential, kernel network guard, owned loopback endpoint) each own their boundary; fake SDKs and frontend fixtures do not qualify them.
- Runtime image: `apps/orb-runtime/src/dockerfile.contract.test.ts` requires every local workspace's `package.json` before `npm ci` and its source after ([postmortem](postmortems/2026-08-08-runtime-image-dangling-workspace.md)). The dependency-graph contract checks every declared lock edge; `npm ci` and audit are not closure proofs. The sealed patch installer checks package/version/patch/file hashes, idempotence, drift and Git-root isolation (`docs/stack.md`).

## Native VM coverage

Native VM integration requires unit and DST coverage before deployment; live checks do not substitute.

- **Unit/contract:** build inputs and prerequisite errors; image identity/manifest/fingerprint; Compute requests and permission failures; metadata validation and credentials; bootstrap, mounts and systemd; `orb`/sudo ownership; Docker disabled by default; sealing, failed-build cleanup and protection of unrelated resources. Exercise failure paths, not generated text.
- **DST:** orchestration, retries and lifecycle transitions on simulated clocks/effects: partial build/publication failure, cancellation and cleanup, competing operations/generations, Stop/Start, Spot interruption, replacement, token fencing, diagnosis-before-discard. Assert retained workspace data, one authoritative incarnation, no unvalidated image publication, no foreign deletion.
- **Real integration:** GCE, Linux mounts/systemd, image boot/sealing, tools, retained storage and failure reporting. Runtime changes keep the browser/runtime E2E gate.
- Builder, validator and provider tests share the fixed 50 GiB workspace shape; guest tests assert metadata-only admission and exact size-mismatch failures with no formatting/resizing ([postmortem](postmortems/2026-09-08-workspace-image-readonly-check.md)).
- The runtime supervisor has unit (health, retry, terminal reporting, exit races, signals), DST (initialization past ten minutes without a supervisor deadline) and real-subprocess (exit codes, signals, process-group cleanup) coverage; image acceptance checks the systemd command, HTTP readiness and the durable `runtime ready` guest attribute.
- The disposable validation broker implements every mandatory boot read (project secrets, model credentials, empty MCP catalog); unknown calls fail.
- Keep stateful logic behind testable boundaries so the rebuild command and the release path run the same tested code.

## Smoke and release contracts

- Live smoke waits follow product bounds: 15 minutes per boot, overall deadline covering every sequential boot/stop/network check (`infra/smoke-timeout.contract.test.mjs`).
- Smoke runners use fake clocks/processes/fetches for classified retry, shared deadlines, Retry-After, replay safety and token-safe diagnostics (`infra/smoke_http_test.py`, `infra/smoke_external_test.py`, `infra/smoke_fixture_test.py`). Cleanup requires verified deletion before PASS ([postmortem](postmortems/2026-10-19-lifecycle-smoke-auth.md)). These are runner tests, not live qualification.
- Failed live fixtures are retained for diagnosis with exact IDs and a cost warning; successful ones are deleted; local credential scratch is always removed (`infra/smoke-cleanup.test.mjs`, [postmortem](postmortems/2026-09-09-deleted-browser-reconciler.md)).
- The live GCE replacement probe `infra/smoke-compute-replacement.sh` is operator-run, not routine CI; it needs `PI_ORB_USER_ID` and a deployment with `PI_ORB_E2E_LAUNCH_FAILURE_MARKER`, and writes allowlisted evidence under `test-failures/` (or `PI_ORB_SMOKE_LOG_DIR`). Direct shell and HTTP-adapter tests cover authentication, allowlisted summaries, namespace refusal, record-before-create, deletion confirmation and cleanup verdicts; they do not qualify whole-script lifecycle wiring or live GCE ([postmortem](postmortems/2026-10-22-replacement-smoke-fixture-budget.md)).
- Release guards have deterministic coverage (activation, authority, retirement metrics, pagination, pending operations, classified failures, allowlisted results). Shell contracts require checks/E2E and migrations before apply, preserve uncertain migration locks and forbid build/apply in validation-only mode. They do not substitute for a live release.
- Foundation OpenTofu checks use `infra/foundation/test-tofu.sh`; release-report contracts own deployment uploads; browser-evidence contracts own E2E uploads.

## End-to-end acceptance

1. Create a project and select central Pi or native Claude.
2. Admit a browser message durably through the inbox with coherent operation and receipt identity.
3. Acquire context and execution through the selected harness; run a real workspace tool.
4. Render streamed text, tools and errors, then retire output atomically with committed history.
5. Reconnect and read stopped history without waking compute; continue without duplicates or gaps.
6. Stop/Start and replace compute, retaining workspace and native authority under their owners.
7. Abort, sleep, archive and delete through their admission, drain and cleanup fences.
8. Inject storage, publication, transport and owner-restart failures deterministically, with stable IDs and replayable traces.

The browser↔runtime E2E covers stopped submission → startup → delivered history and busy submission → steer.

Device approval, refresh and rejected credentials touch only mock authority. Interrupted unsafe effects are never replayed automatically. MCP and child tests enforce callback scope and keep private transcripts out of public history. Native Claude acceptance includes the real SDK subprocess/history/stream boundary; central Pi acceptance includes native Durable PostgreSQL state and incarnation-fenced execution RPC.

## Approved exceptions

Each waives only explanation/attribution of the named historical failure. Evidence stays preserved; no cause or fix is claimed. New failures, assertions, exact-head qualification, fixture cleanup and DST replay/root-cause requirements are never waived.

| Scope | Approved | Evidence |
| --- | --- | --- |
| WebKit compositor crash during validation: deployment allowed without cause | 2026-09-15 | [postmortem](postmortems/2026-09-14-webkit-compositor-validation-crash.md) |
| UI tests: deep investigation of a historical flaky UI failure is optional once corrective stabilization is evidenced (a rerun alone is not stabilization) | 2026-10-05 | — |
| Two older native Claude synthetic-fixture timeouts with lost diagnostics | 2026-10-05 | — |
| Debian WebKit network-process segfault: three unchanged passes on pinned Ubuntu clear the qualification blocker (Debian cause unknown) | 2026-10-05 | — |
| Historical profile-login challenge timeout and upload-continuation stall | 2026-10-06 | [run 37390585414](https://github.com/schani/pi-orb/actions/runs/37390585414), [run 37389785804](https://github.com/schani/pi-orb/actions/runs/37389785804), `TODO.md` |
| Pi continuation timeout in E2E run 37415836008 | 2026-10-06 | [run](https://github.com/schani/pi-orb/actions/runs/37415836008) |
| PR 66 WebKit navigation failures | 2026-10-08 | [postmortem](postmortems/2026-10-08-webkit-reload-internal-error.md) |
| PR 66 hosted Pi provider HTTP stalls and truncated `libproc2-0` download | 2026-10-08 | [postmortem](postmortems/2026-10-08-subagent-post-tool-missing-request.md), [postmortem](postmortems/2026-10-08-runtime-apt-size-mismatch.md) |
| Historical frontend/browser process crashes (e.g. PR 100 WebKit network-process crash), independently of stabilization | 2026-10-14 | [job](https://github.com/schani/pi-orb/actions/runs/38589563561/job/115940497731) |
| PR 124 shard-3 exit 139 | 2026-10-15 | [job](https://github.com/schani/pi-orb/actions/runs/38823555927/job/116725597504) |
| PR 122 600 s whole-image-build timeouts (Deploy 38800758118) | 2026-10-15 | [postmortem](postmortems/2026-10-15-runtime-dependency-qualification.md) |
| Identity-smoke cleanup cause in Deploy 38596107385 (diagnostics deferred to `TODO.md`) | 2026-10-15 | [postmortem](postmortems/2026-10-14-identity-smoke-cleanup.md) |
| PR 137 local PostgreSQL MCP `beforeEach` 10 s and aggregate-image 30 s timeouts | 2026-10-16 | — |
| Original image/20 MiB 30 s unit timeouts (not the metadata assertion failures) | 2026-10-19 | [postmortem](postmortems/2026-10-19-image-test-cpu-contention.md) |
| Durable 39844782648 npm exit 152 | 2026-10-22 | [postmortem](postmortems/2026-10-22-local-fake-npm-preparation.md) |
| PR 162 hosted-fake inference waits | 2026-10-22 | [PR 162](https://github.com/schani/pi-orb/pull/162) |
| Local replacement-smoke 90 s `TimeoutExpired` (not the controlled 40%-CPU failures) | 2026-10-23 | [postmortem](postmortems/2026-10-22-replacement-smoke-fixture-budget.md) |
| PR 163 SIGSEGV exit 139 (run 39961953749) | 2026-10-23 | [job](https://github.com/schani/pi-orb/actions/runs/39961953749/job/120441887000) |
| Two `CreateArtifact ETIMEDOUT` upload failures in Durable 40032475539 | 2026-10-23 | [job](https://github.com/schani/pi-orb/actions/runs/40032475539/job/120683831684) |
| `postgres:16` acquisition HTTP 500 / Docker exit 125 in E2E 39960599734 shard 3 | 2026-10-24 | [job](https://github.com/schani/pi-orb/actions/runs/39960599734/job/120437327491) |
| PR 192 native E2E shard-4 exit 139 | 2026-10-24 | [job](https://github.com/schani/pi-orb/actions/runs/40114091476/job/120931701773) |
