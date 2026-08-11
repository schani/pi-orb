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

## Directory layout

```text
apps/
  control-plane/
    src/
      domain/           # polling/lifecycle state machines and interfaces
      adapters/         # PostgreSQL/PGlite clients and Docker/process/GCE adapters
      http/             # Fastify routes and WebSocket proxy
  orb-runtime/
    src/
      pi/               # Pi SDK integration and history mapping
      http/             # history pull and live WebSocket endpoints
  web/                  # React browser UI

packages/
  protocol/             # TypeBox schemas and inferred wire/history types
  luna/                 # Shared Luna model/request/response adapter policy

infra/
  opentofu/             # added when the cloud slice begins

docker-compose.yml      # local PostgreSQL and static development services
package.json
tsconfig.base.json
```

`protocol` is shared because it has three real consumers. `luna` was extracted only after both the control plane's orb auto-naming and the runtime's turn notifications needed the same model selection, no-tool/minimal-reasoning options, response parsing, and typed provider-error mapping (decided 2026-08-07); prompts, credentials, scheduling, and product-specific output validation remain in their owning applications. Keep `OrbHostProvider`, repositories, broader Pi integration, fakes, and tests inside the application that owns them. Extract other domain, adapter, provider, or test-support packages only when another application genuinely needs them.

The web app depends on `protocol`, not control-plane implementation code. Domain directories contain no Fastify, React, PostgreSQL, Docker, or Pi imports. Avoid generic `common` or `utils` packages.

## Dependencies that earn their keep now

Runtime dependencies:

- `neverthrow`: mandatory Result-based error handling;
- `determined`: mandatory deterministic scheduling/failure simulation;
- `@earendil-works/pi-coding-agent`: the first harness;
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
- `@playwright/test` only when the browser E2E test is implemented.

Everything else should begin as first-party code or use an existing CLI.

## HTTP, WebSocket, and schemas

Keep Fastify, `@fastify/websocket`, and TypeBox because replacing them would mean writing and securing our own router, request body handling, upgrade lifecycle, and runtime validators. Share TypeBox schemas through `packages/protocol` and infer types from them.

Use native `fetch` for HTTP. Wrap external calls immediately with `ResultAsync.fromThrowable`, validate status and body explicitly, and return a typed error. Do not use tRPC, Axios, or a generated API client initially.

## Database

Use `pg` directly with parameterized SQL. The initial schema and query set are small, and adding Kysely now would duplicate abstractions before it provides enough value.

- Write explicit transaction helpers that issue `BEGIN`, `COMMIT`, and `ROLLBACK` and return `ResultAsync`.
- Keep numbered SQL migration files and a small migration runner.
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

Use the shared TypeBox schemas to validate data received by the browser. Add Playwright when the first browser E2E flow exists. Defer styling/component-library selection.

## Tests, logging, Docker, and infrastructure

- Use Vitest for domain, protocol, adapter, component, and `determined` tests.
- Use real PostgreSQL and Docker integration tests where fakes cannot establish adapter correctness.
- Use a tiny structured JSON logging wrapper around `console` initially instead of Pino.
- Implement `DockerOrbHostProvider` by invoking the Docker CLI with `execFile`, wrapped at the boundary, instead of adding Dockerode.
- Invoke the Git CLI directly for cloning rather than adding a Git library.
- Add OpenTofu/Terraform only when implementing the cloud deployment; it is not an application dependency.
- Add the GCE client only when `GceOrbHostProvider` is implemented.

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
