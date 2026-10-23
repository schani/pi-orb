# Repository layout and stack

These choices are accepted for the first vertical slice. Start small and extract or add dependencies only after a concrete need appears.

## Language and workspace

Recommend:

- TypeScript throughout the runtime, control plane, web UI, shared contracts, and tests;
- Node.js 24 and ESM modules;
- npm workspaces using the npm already shipped with Node, one lockfile, and no additional package-manager dependency;
- no Nx, Turborepo, or general task orchestrator;
- `tsc --build` for type checking/production compilation and Vite only for the browser build;
- Node's built-in TypeScript stripping for server-side development/tests where its supported erasable syntax is sufficient;
- strict compiler options including `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, and `erasableSyntaxOnly` where compatible.

TypeScript lets the Pi SDK, `determined`, `neverthrow`, protocol schemas, server, and browser share one type system. Network boundaries still require runtime validation; compile-time sharing is not wire validation.

**Toolchain decision (2026-10-16).** Use Node 24.22.0 LTS, Vite 8.3.4 with React plugin 6.1.2, and Vitest 5.0.5: update the supported LTS and build/test tools together, not Node 26 Current or the Pi family. Root owns Vite explicitly for Vitest's peer, pins `@types/node` 24.19.2 to the runtime major, and owns esbuild 0.28.2 for native build consumers independently of Chord's hoisting. Preserve existing browser targets explicitly rather than adopting Vite 8's narrower default. Vite's Rolldown/Oxc and native artifacts require clean-install/build qualification; Node changes also require PTY and runtime E2E gates. Evidence and limits: `docs/dependency-audit.md`, `docs/testing.md`.

**Node security decision (2026-10-22).** Pin Node 24.22.1 across CI, Docker and native builds for the [TLS, DNS and Brotli security fixes](https://nodejs.org/en/blog/release/v24.22.1), staying on Node 24 LTS. Bundled npm remains 11.19.1; npm dependencies and the Pi family are unchanged. Native archives use the official signed SHA-256 manifest; installed Node inventory and build-phase logs retain the existing diagnostics. Qualification and limits: `docs/testing.md`.

**Maintenance decision (2026-10-22).** Refresh the existing Fastify plugins, IP parser, PostgreSQL clients/types, Markdown parser, WebSocket implementation/types and Zod within their current release lines. Pin Biome 2.6.2, Vite 8.3.5 and Playwright 1.64.1; preserve workspace range policy. Static's content-disposition 3 and pg's protocol/connection-string patches follow their owning dependencies. Pi stays aligned at 1.3.0 with its sealed patches. Qualification and lint-scope rationale: `docs/testing.md`.

**Pi decision (2026-10-16).** Upgrade the aligned Pi family to 1.3.0 and use Durable's native code-mode adapter. Upstream owns nested tasks/journals and replay; pi-orb supplies scoped tools, resource/cancellation policy and private user-facing output. Native documents/tasks use existing PostgreSQL JSON storage, preserving completed history without a compatibility phase for unfinished custom executions. Rationale and persistence boundaries: `docs/pi-durable-evaluation.md`; qualification: `docs/testing.md`.

**Pi decision (2026-10-22).** Align Chord and all eight Pi packages on published stable 1.4.0, retaining coding-agent's ModelRuntime/auth/skills role. The only new non-Pi lock entry is pi-tui's required `marked-cjk-friendly@0.1.2`; unrelated dependencies stay fixed. Rebase all four sealed patches across all 18 files against published tarballs, preserving broker diagnostics, native sandbox/journal/image bounds, atomic backlog admission and `model_error` backlog draining. ModelRuntime retains upstream OpenCode session headers; Durable keeps the new sleeping/restart/telemetry contracts. The failure patch uses upstream continuation helpers only for `model_error`; no-model follows upstream `afterFailedRun` (default `keep`), with no new persisted setting. Optional trace propagation remains off. Persisted-state approval, scheduler/report integration and recovery evidence: `docs/pi-durable-evaluation.md`. Published inputs and every old-to-new patch hunk: `patches/pi-1.4.0.PROVENANCE.md`. This upgrade does not remediate Pi-owned Undici 8.10.2 and adds no override.

## Directory layout

```text
apps/
  control-plane/
    src/
      domain/           # polling/lifecycle state machines and interfaces
      adapters/         # central Pi Durable, PostgreSQL/PGlite, host adapters
      http/             # Fastify routes and WebSocket proxy
  orb-runtime/
    src/
      claude/           # native Claude harness, boot and history
      execution/        # workspace RPC and guest services
      http/             # history pull and live WebSocket endpoints
      inspection/       # in-orb sibling listing and replicated-transcript CLI
  web/                  # React browser UI

packages/
  protocol/             # TypeBox schemas and inferred wire/history types
  luna/                 # Central auxiliary model/request/response adapter policy

infra/
  opentofu/             # added when the cloud slice begins

docker-compose.yml      # local PostgreSQL and static development services
package.json
tsconfig.base.json
```

`protocol` is shared because it has three real consumers. Central auxiliary inference uses `luna` for fixed model selection, no-tool/minimal-reasoning options, response parsing and typed provider errors. The concrete turn-summary adapter belongs in `apps/control-plane/src/adapters/luna-summarizer.ts`; the summary coordinator consumes its port without importing Pi. Prompts, credentials, scheduling and product-specific output validation remain with their owners. Keep `OrbHostProvider`, repositories, broader Pi integration, fakes, and tests inside the application that owns them. Extract other domain, adapter, provider, or test-support packages only when another application genuinely needs them.

The web app depends on `protocol`, not control-plane implementation code. Domain directories contain no Fastify, React, PostgreSQL, Docker, or Pi imports. Avoid generic `common` or `utils` packages.

## Dependencies that earn their keep now

Runtime dependencies:

- `neverthrow`: mandatory Result-based error handling;
- `determined`: mandatory deterministic scheduling/failure simulation;
- `@earendil-works/pi-durable`: central Pi conversation/task authority and execution environments;
- `@earendil-works/pi-coding-agent`: central model/auth/skill helpers;
- `@anthropic-ai/claude-agent-sdk`: host-native Claude;
- `fastify`: robust HTTP routing, body limits, lifecycle, and schema integration for both servers;
- `@fastify/websocket`: WebSocket upgrade/lifecycle integration (and its `ws` implementation);
- `typebox`: one source for runtime JSON validation and inferred TypeScript protocol types;
- `pg`: the production PostgreSQL network client;
- `@electric-sql/pglite`: embedded PostgreSQL for Docker-free local development and store contract tests;
- `react` and `react-dom`: the web UI.

Development/build dependencies:

- the latest stable `typescript` release, pinned exactly so compiler upgrades are explicit;
- `vite` and `@vitejs/plugin-react`;
- `@biomejs/biome`, pinned exactly, for repository-wide linting, formatting, and import organization; a scoped GritQL plugin preserves the no-throw rule for first-party production code while allowing test assertions and deterministic-testkit invariants to throw;
- `vitest` for unit, adapter, component, and deterministic simulation tests;
- `@playwright/test` for focused real-browser E2E coverage, beginning with frontend-only IAP-session recovery (`docs/testing.md`; added 2026-09-03).

Everything else should begin as first-party code or use an existing CLI.

**Dependency patch installation (2026-10-18).** Root and packaged control-plane installs run `node scripts/apply-dependency-patches.mjs` after locked npm installation. The single patch set covers Pi AI, coding-agent ModelRuntime, codemode and Durable. The runner validates exact package versions, patch SHA-256 and pristine/patched file hashes before any mutation. It canonicalizes the install root, clears inherited Git configuration/environment and prevents enclosing-repository discovery. Missing inputs, drift or application failure reject with patch-specific diagnostics; already-applied patches pass reverse checks. Execution/Claude hosts install unmodified locked production dependencies, without the patch runner or patch files. Guest/native loaded-closure checks verify zero patched files; installed transitive package presence does not imply a loaded harness or patch requirement.

Git remains an installation prerequisite. The scoped runner avoids a patch parser/fork and the vulnerable installer-only `patch-package → find-yarn-workspace-root → micromatch → braces` chain ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)). Rejected: official patch-package 8.0.1 and its canary retain that chain; 6.0.7 adds vulnerable `tmp`. Native sandbox, image-decoder and replay changes retain strict provenance (`patches/pi-codemode.PROVENANCE.md`, `patches/pi-durable.PROVENANCE.md`); exact-source qualification is recorded in `docs/testing.md`.

**Security dependency refresh (2026-10-22).** MCP client `2.3.1` (and its exact core dependency) fixes cross-origin redirect credential forwarding ([GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw)). Fastify `5.12.7` fixes case-sensitive header-schema validation ([GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8)); no first-party `propertyNames` header schema was found. SDK `1.32.1` retains its Express limiter range; the lock resolves `express-rate-limit → ip-address` to `10.7.4`, fixing unbounded IPv6 zone parsing ([GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)). No first-party use of that parser or SDK Express OAuth handlers was found. These are affected-dependency fixes, not demonstrated application exploits.

Direct Undici stays on the maintained 7.x line at [`7.30.1`](https://github.com/nodejs/undici/releases/tag/v7.30.1). Production imports supply socket-time DNS-guarded Agents to native fetch in the MCP probe/OAuth adapters; TLS renegotiation errors can reach this transport ([GHSA-qrxm-fqhp-jwvm](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm)). The release also preserves function-valued Agent TLS options ([GHSA-2m5v-pch6-74hx](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx)); reviewed adapters use `connect.lookup`, not custom certificate verification. Existing public-address checks, `redirect: "error"`, typed failures and redacted OAuth diagnostics remain required. A credential-bearing OAuth regression verifies callers cannot enable redirects.

**Residual Pi-owned Undici (2026-10-22).** `@earendil-works/pi-coding-agent@1.4.0 → undici@8.10.2` remains pinned. Its `dist/core/http-dispatcher.js` is in the static index import closure; CLI/RPC/interactive entrypoints call `configureHttpDispatcher`, which installs an EnvHttpProxyAgent and, unless overridden, Undici globals. Reviewed central adapters use ModelRuntime, not these entrypoints; package loading alone does not prove network use. [8.12.2](https://github.com/nodejs/undici/releases/tag/v8.12.2) fixes TLS-renegotiation and content-encoding crashes, Agent TLS-option loss, redirect/cache disclosure, decompression-handler exceptions, mixed-case SRI bypass and EventSource/WebSocket buffering. No first-party shared-cache/decompress composition, custom certificate verification, SRI or Undici EventSource usage was found; exploitability through the nested copy is not established or cleared. Node's bundled fetch is a separate remediation boundary.

Decision: Pi `1.4.0` retains `8.10.2`; nested remediation remains in `TODO.md`. A family upgrade alone is insufficient. Prefer an upstream Pi release with a fixed dependency; otherwise explicitly review a Pi-scoped override or sealed upstream backport, with dispatcher/global-fetch/provider qualification. No override or nested fix is included here.

## HTTP, WebSocket, and schemas

Keep Fastify, `@fastify/websocket`, and TypeBox because replacing them would mean writing and securing our own router, request body handling, upgrade lifecycle, and runtime validators. Share TypeBox schemas through `packages/protocol` and infer types from them.

Use native `fetch` for HTTP. Wrap external calls immediately with `ResultAsync.fromThrowable`, validate status and body explicitly, and return a typed error. Do not use tRPC, Axios, or a generated API client initially.

## Database

Use `pg` directly with parameterized SQL. The initial schema and query set are small, and adding Kysely now would duplicate abstractions before it provides enough value.

- Write explicit transaction helpers that issue `BEGIN`, `COMMIT`, and `ROLLBACK` and return `ResultAsync`.
- Keep numbered SQL migration files and a small migration runner. Applied migrations are keyed by full filename and sorted lexicographically. The locally applied `029_orb_harness.sql` retains its name alongside `029_history_record_shape.sql`; their prefixes are not identities. Renaming it would reapply its column addition to the retained POC database (decided 2026-10-05).
- Validate/map database rows at the adapter boundary rather than trusting untyped driver output.
- Define repository interfaces next to the control-plane domain code.
- Provide a deterministic in-memory implementation for DST and real PostgreSQL integration tests.

Add a typed query builder later only if query volume or refactoring pain demonstrates the need. Do not use a transaction API that requires throwing to roll back.

### Embedded PGlite composition (decided and implemented 2026-08-07)

The container-restricted pi coding-agent environment has no PostgreSQL server binaries installed. The Docker-free composition therefore uses PGlite, PostgreSQL compiled to WebAssembly and embedded in the control-plane process. `PI_ORB_DATABASE_KIND=pglite` uses the filesystem-backed directory configured by `PI_ORB_PGLITE_PATH`; the root `npm run dev:local` command selects it together with `PI_ORB_HOST_PROVIDER=process`. Tests construct PGlite without a path for an ephemeral in-memory database. Local development remains filesystem-backed by default because conversation history and credential pointers must survive control-plane restarts.

PGlite and network PostgreSQL implement a small `PostgreSQLClient` query/transaction boundary. Both feed the same `PostgreSQLControlPlaneStore`, `PostgreSQLCredentialPointerStore`, numbered migrations, row mapping, and SQL. The prior SQLite adapter was rejected and removed: although it enabled Docker-free execution, it duplicated the complete schema and store implementation while testing different type, JSON, constraint, and transaction semantics. The replacement removes that divergence and lets the backend-agnostic store contract suite observe the domain interfaces against production SQL.

**Parameter-intent rule (decided 2026-08-11, from `docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`).** The two clients do **not** bind parameters the same way: node-postgres encodes from the JavaScript value (a JS array becomes a PostgreSQL array literal, a plain object becomes JSON), PGlite from the parameter OID the server reports. Structured parameters therefore state their intent — `jsonParam()` for a `json`/`jsonb` column, `arrayParam()` for a PostgreSQL array — and a shared prepare step in both clients rejects any remaining bare array or bare plain object with a non-retryable `invariant` `StoreError` before the driver is called. `jsonParam(null)` binds SQL NULL, never `'null'::jsonb`. The store contract runs on both drivers (`docs/testing.md`, store-substrate rule); SQL text equality is not driver equality.

`StoreError` has three classes. `unavailable` is a retryable outage, `corruption` is a constraint violation (`23503`/`23505`/`23514`), and `invariant` is a deterministic bug of ours — SQLSTATE class `22` or `42`, or the parameter guard above. An `invariant` never carries `retryable: true`, answers HTTP 500 `internal` rather than 503, and parks the loops that would otherwise re-attempt it forever (`docs/lifecycle.md`).

PGlite is single-user/single-connection. Its exclusive transaction API and explicit rollback preserve the required semantics for one control-plane process, including lifecycle and credential-pointer CAS, atomic replication commits, deferred constraints, JSONB, timestamps, and recursive history reconstruction. It does **not** establish connection-pool behavior, network error mapping, or serialization between multiple control-plane instances. Real PostgreSQL E2E/integration tests and deploy smoke tests remain authoritative for those properties. The same full-slice E2E runs with PGlite + the process host when `PI_ORB_E2E_BACKEND=process`, and with a PostgreSQL server + Docker by default.

## Web UI

Use React with Vite, browser APIs, and a small first-party reducer/context for HTTP and WebSocket state.

Do not add TanStack Router, TanStack Query, or a state-management package initially. The first UI has few routes and one live session. Add a router or query-cache library only after navigation/caching behavior becomes nontrivial.

Use the shared TypeBox schemas to validate data received by the browser. Playwright drives the small set of interactions that require a real browser and cannot be established by SSR or transport tests; keep ordinary components on Vitest. Defer styling/component-library selection.

## Tests, logging, Docker, and infrastructure

- Use Vitest for domain, protocol, adapter, component, and `determined` tests.
- Use real PostgreSQL and Docker integration tests where fakes cannot establish adapter correctness.
- Use a tiny structured JSON logging wrapper around `console` initially instead of Pino.
- Implement `DockerOrbHostProvider` by invoking the Docker CLI with `execFile`, wrapped at the boundary, instead of adding Dockerode.
- Invoke the Git CLI directly for cloning rather than adding a Git library.
- Add OpenTofu/Terraform only when implementing the cloud deployment; it is not an application dependency.
- Add the GCE client only when `GceOrbHostProvider` is implemented.
- Implement OIDC workload-identity signing (RS256 JWTs, JWK export, RFC 7638 `kid` thumbprints; `docs/workload-identity.md`) as first-party code over `node:crypto` behind the signer port, instead of adding `jose` (decided 2026-08-21). Node 24's `crypto` provides RSA key generation, signing, and JWK export natively; the JOSE surface we need is on the order of a hundred lines and must sit behind a DST-fakeable port either way. Rejected alternative: `jose`, defensible because JOSE serialization details are easy to get subtly wrong — revisit if the issuer grows beyond RS256 or the hand-rolled surface accretes.

Test framework assertions and React/framework error boundaries may use exceptions where their contracts require them; production/domain APIs remain Result-based. Every external adapter owns immediate exception/rejection conversion. No Docker, database, filesystem, Git, HTTP, Pi SDK, or future GCP exception may cross into domain code.

## Error handling

- First-party code does not use exceptions for expected or recoverable control flow.
- Synchronous fallible operations return `neverthrow` `Result<T, E>`.
- Asynchronous fallible operations return `ResultAsync<T, E>`.
- Public domain, adapter, and service APIs expose explicit discriminated error types rather than raw `Error` objects.
- Calls into third-party or platform code that can throw or reject must be caught at the immediate boundary with `Result.fromThrowable`, `ResultAsync.fromThrowable`, or an equivalent narrow wrapper, then mapped into a typed application error.
- Do not allow a rejected promise from an external dependency to escape into first-party domain code.
- Exceptions are allowed only where a framework or third-party callback contract requires them, such as a top-level framework error boundary. Such exceptions must be contained at that boundary and converted to/logged as typed failures where possible.
- Database transaction rollback must not depend on first-party code throwing. Use an explicit/controlled transaction API and return a `Result`.
- Lint rules should reject `throw` statements in first-party source, with narrowly documented overrides only for required boundaries.
