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
      adapters/         # PostgreSQL/SQLite and Docker/process/GCE adapters
      http/             # Fastify routes and WebSocket proxy
  orb-runtime/
    src/
      pi/               # Pi SDK integration and history mapping
      http/             # history pull and live WebSocket endpoints
  web/                  # React browser UI

packages/
  protocol/             # TypeBox schemas and inferred wire/history types

infra/
  opentofu/             # added when the cloud slice begins

docker-compose.yml      # local PostgreSQL and static development services
package.json
tsconfig.base.json
```

Only `protocol` is a shared package initially because it has three real consumers. Keep `OrbHostProvider`, repositories, Pi integration, fakes, and tests inside the application that owns them. Extract `domain`, adapters, providers, or test-support packages only when another application genuinely needs them.

The web app depends on `protocol`, not control-plane implementation code. Domain directories contain no Fastify, React, PostgreSQL, Docker, or Pi imports. Avoid generic `common` or `utils` packages.

## Dependencies that earn their keep now

Runtime dependencies:

- `neverthrow`: mandatory Result-based error handling;
- `determined`: mandatory deterministic scheduling/failure simulation;
- `@earendil-works/pi-coding-agent`: the first harness;
- `fastify`: robust HTTP routing, body limits, lifecycle, and schema integration for both servers;
- `@fastify/websocket`: WebSocket upgrade/lifecycle integration (and its `ws` implementation);
- `typebox`: one source for runtime JSON validation and inferred TypeScript protocol types;
- `pg`: the production/default-local PostgreSQL layer; Node 24's built-in `node:sqlite` serves only the Docker-free test composition;
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

### Test-only SQLite composition (decided and implemented 2026-08-07)

The container-restricted pi coding-agent environment has no PostgreSQL server or client binaries installed, and its apt package indexes are absent. Node 24 does provide the built-in `node:sqlite` module, so local process-host testing avoids installing or supervising another service. `PI_ORB_DATABASE_KIND=sqlite` uses the configured `PI_ORB_SQLITE_PATH` (the adapter does not choose a state directory) and is selected together with `PI_ORB_HOST_PROVIDER=process` by the root `npm run dev:local` command. Production and the default Docker/GCE E2E continue to use PostgreSQL.

The domain abstraction was sufficient: lifecycle/history code depends on `ControlPlaneStore`, and the credential broker depends on `CredentialPointerStore`. PostgreSQL leaks into application composition and its adapter implementation, not into those domain interfaces. The implementation adds `SqliteControlPlaneStore`, `SqliteCredentialPointerStore`, SQLite-specific schema initialization, and a composition-level `ControlPlaneDatabase` lifecycle interface, so `main.ts` no longer constructs, migrates, and closes `PgClient` unconditionally. The PostgreSQL classes are named `PostgreSQLControlPlaneStore` and `PostgreSQLCredentialPointerStore` consistently with their SQLite peers. SQLite uses built-in `node:sqlite`; SQL is adapter-specific rather than translated or hidden behind an ORM/query builder.

SQLite can preserve the required semantics for a **single control-plane process**:

- lifecycle compare-and-swap remains an `UPDATE ... WHERE state_version = ?` followed by a row-count check;
- replication commit and session initialization run under one serialized transaction, preserving cursor CAS, idempotent record insertion, and atomic cursor/head advancement;
- JSON values are encoded as text and validated/mapped at the adapter boundary; timestamps are integer milliseconds; UUIDs are text;
- recursive CTEs can reconstruct the parent chain; indexes and foreign keys remain available (`PRAGMA foreign_keys = ON`);
- credential pointer writes retain their row-version CAS;
- one synchronous `node:sqlite` connection makes each transaction callback non-interleavable in the single JS process; adapter operations are short local calls wrapped immediately into typed `Result`/`ResultAsync` values, and no exception crosses the adapter boundary.

This mode deliberately does **not** establish PostgreSQL behavior. SQLite has one-writer locking and different isolation, type, constraint, JSON, and error-code behavior; in particular, it cannot validate the production adapter's row-locking and deferred-constraint behavior under multiple control-plane instances. PostgreSQL integration tests, the Docker/GCE E2E, and deploy smoke tests remain authoritative for those properties. SQLite is sufficient for the real browser/control-plane/runtime handshake, local persistence, stop/start, history replication semantics, and credential-broker behavior in the one-process test composition. This is covered by adapter tests and by running the full-slice E2E with `PI_ORB_E2E_BACKEND=process`; the same E2E remains PostgreSQL + Docker by default.

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
