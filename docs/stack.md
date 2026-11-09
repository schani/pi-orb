# Repository layout and stack

Start small; add a dependency or extract a package only after a concrete need appears. Error-handling rules are owned by `AGENTS.md` ("Error handling").

## Toolchain

TypeScript throughout (runtime, control plane, web UI, shared contracts, tests), ESM only, npm workspaces with one lockfile. No Nx, Turborepo or other task orchestrator. `tsc --build` type-checks and compiles servers; Vite builds only the browser. Server-side development and tests use Node's built-in type stripping. Compiler options are strict, including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables` and `erasableSyntaxOnly`. Shared types are not wire validation: network boundaries validate at runtime.

Exact pins live in the root and workspace `package.json` files and `package-lock.json`; this table names the lines and why.

| Tool | Line | Notes |
|---|---|---|
| Node.js | 26 LTS | Pinned identically in `.github/workflows/*.yml`, both Dockerfiles and `infra/native-vm/install.sh` (archive checksum from the official signed SHA-256 manifest). Node 26 has V8's Wasm wrapper lifetime protection that Node 24 lacks (`docs/postmortems/2026-10-28-node-wasm-wrapper-lifetime.md`). |
| npm | 12 | Root `packageManager`. CI, every Docker stage and native installs install and verify it before use. Locally: `npm install --global npm@<packageManager version>` and check `npm --version` before `npm ci`. Hoisted install, lockfile v3. |
| TypeScript | 7 | Pinned exactly so compiler upgrades are explicit. |
| Vite / `@vitejs/plugin-react` | 8 / 6 | Plain `react()`, no Babel options or optional compiler peers. Browser targets stay explicit (`chrome107`, `edge107`, `firefox104`, `safari16`) rather than Vite 8's narrower default. Root owns Vite for Vitest's peer. |
| Vitest | 5 | Unit, adapter, component and DST tests. |
| Playwright | 1.x | Real-browser E2E only where SSR/transport tests cannot establish behavior (`docs/testing.md`). |
| Biome | 2.x | Pinned exactly with its schema; lint, format, import organization. |
| Pi family (`@earendil-works/*`) | 1.5 | Chord and every Pi package move together, with the sealed patches (`docs/pi.md`). |
| Claude Agent SDK / CLI | aligned | Host-native Claude (`docs/claude.md`). |
| esbuild | root-owned | Native build/acceptance tooling; must not depend on Chord's hoisting. |

**npm 12 lifecycle scripts.** Dependency scripts are denied by default. `allowScripts` approves exactly node-pty, Claude's native CLI install and esbuild's binary-version guard; without them npm 12 leaves Claude's CLI as a placeholder and skips esbuild's mismatch check. All other hooks stay blocked (agent-browser repairs its own executable bits; the Google/protobuf hooks are unneeded). Image installs keep `--ignore-scripts`, explicit sealed control-plane patching and node-pty-only rebuild/spawn gates. npm 12 refuses bundled lifecycle scripts even when allowlisted, so the isolated fake-provider wrapper explicitly runs only Fling's bundled SQLite install script after locked install and version checks (`docs/postmortems/2026-11-04-npm12-bundled-sqlite.md`).

**Lint.** A scoped GritQL plugin enforces no-`throw` in first-party production code while allowing test assertions and testkit invariants. Markdown/YAML formatters stay disabled (enabling them would rewrite unrelated files). `noComponentHookFactories` is off only in `apps/web/src/lib/create-orb-request.test.ts`, where it mistakes `Intl.DateTimeFormat` doubles for components.

## Directory layout

```text
apps/
  control-plane/src/
    domain/           # lifecycle/polling state machines and ports
    adapters/         # central Pi Durable, PostgreSQL/PGlite, Docker/GCE/process hosts, auth
    http/             # Fastify routes and WebSocket proxies
  orb-runtime/src/
    claude/           # native Claude harness, boot and history
    execution/        # workspace RPC and guest services
    http/             # history pull, live WebSocket, runtime endpoints
    inspection/       # in-orb CLI: siblings, transcripts
  web/                # React browser UI
packages/
  protocol/           # TypeBox schemas and inferred wire/history types
  luna/               # central auxiliary-model request/response policy
  mock-openai/        # fake inference for tests
  native-image/       # GCE image builder
infra/                # OpenTofu roots, release scripts, native-VM install
patches/              # sealed Pi patches and provenance
scripts/              # patch runner, fake provider, smokes, diagnostics
e2e/                  # end-to-end suites
```

`protocol` is shared because it has three real consumers; the web app depends on it, never on control-plane code. `luna` owns fixed auxiliary model selection, no-tool/minimal-reasoning options, response parsing and typed provider errors; prompts, credentials, scheduling and output validation stay with their owners (the turn-summary adapter is `apps/control-plane/src/adapters/luna-summarizer.ts`). `OrbHostProvider`, repositories, Pi integration, fakes and tests stay inside the owning application. Domain directories import no Fastify, React, PostgreSQL, Docker or Pi. No generic `common`/`utils` packages.

**Dependency ownership.** Declare a dependency in the workspace that imports or executes it; an import-only scan is not enough (peers, executables and fixtures count). The runtime owns Chord (execution server imports) and production `ws` (`preview/loopback-websocket.ts`) and `determined`. `native-image` keeps `determined` as a dev dependency (types for DST tests only). Root build tools are not duplicated into workspaces.

## Dependencies

Runtime:

- `neverthrow` (Result-based errors) and `determined` (deterministic simulation) are mandatory.
- `@earendil-works/pi-durable` and family: central Pi authority; `pi-coding-agent` for OAuth login and skill helpers; `pi-ai` Models for inference.
- `@anthropic-ai/claude-agent-sdk`: host-native Claude.
- `fastify` and `@fastify/websocket` (with `ws`) for both servers; `@fastify/static` for control-plane assets. Replacing them means writing and securing our own routing, body handling and upgrade lifecycle.
- `typebox`: one source for runtime validation and inferred protocol types, shared through `packages/protocol`.
- `pg` (network PostgreSQL) and `@electric-sql/pglite` (embedded PostgreSQL); versions and extension policy: `docs/history.md` ("Search").
- `@modelcontextprotocol/client` (control plane only): MCP (`docs/mcp.md`).
- `undici` (direct): socket-time DNS-guarded Agents passed to native fetch in the MCP probe/OAuth adapters. Use `connect.lookup`, never custom certificate verification; keep public-address checks and `redirect: "error"`.
- `google-auth-library` + native fetch for GCE and Google APIs (no generated client); `openid-client`, `@hapi/iron`, `cookie` for login and sealed sessions (`docs/auth.md`).
- `node-pty` and `@wterm/*` (exact) for the terminal (`docs/terminal.md`).
- `react`, `react-dom`, `react-markdown`; Mermaid (lazy, strict security level) and Vega/Vega-Lite (lazy) for transcript diagrams and charts. Mermaid ≥12.2 is required for KaTeX's trust-bypass fix.

Everything else begins as first-party code or an existing CLI. HTTP uses native `fetch` wrapped at the adapter; no tRPC, Axios or generated API client. No router, query-cache or state-management library: the UI uses a small first-party reducer/context and validates received data with the shared schemas. Logging is a tiny structured JSON wrapper over `console`, not Pino. Docker and Git are driven through their CLIs via `execFile`, not Dockerode or a Git library. OIDC signing (RS256, JWK export, RFC 7638 `kid`) is first-party over `node:crypto` behind the signer port; `jose` was rejected while the surface stays RS256-only.

**Overrides** (root `package.json`, each scoped to its owner): Chord's optional exact WebSocket peer → the existing newer `ws`; `@fastify/static` → `glob` 14 and `gcp-metadata` → `gaxios` 7.3 for the glob/minimatch advisories. No global or transitive-major overrides.

**Dependency patches.** Root and packaged control-plane installs run `node scripts/apply-dependency-patches.mjs` after locked install. One patch set covers Pi AI, codemode and Durable. The runner validates exact package versions, patch SHA-256 and pristine/patched file hashes before mutating, canonicalizes the install root, clears inherited Git config/environment and blocks enclosing-repository discovery; drift or failure rejects with patch-specific diagnostics, and already-applied patches pass reverse checks. Execution/Claude hosts install unmodified locked production dependencies; guest loaded-closure checks verify zero patched files. Git is an install prerequisite. Rejected: `patch-package` (its installer chain carries a `braces` advisory; 6.0.7 adds vulnerable `tmp`). Provenance: `patches/*.PROVENANCE.md`.

## Database

`pg` directly with parameterized SQL; no query builder until query volume demands one.

- Explicit transaction helpers issue `BEGIN`/`COMMIT`/`ROLLBACK` and return `ResultAsync`; rollback never depends on throwing.
- Numbered SQL migrations with a small runner. Applied migrations are keyed by full filename, sorted lexicographically: `029_orb_harness.sql` and `029_history_record_shape.sql` share a prefix and both stay (renaming would reapply).
- Rows are validated and mapped at the adapter boundary. Repository interfaces live beside the domain; DST uses deterministic in-memory implementations.
- IDs come from `crypto.randomUUID()`; no PostgreSQL UUID extension.
- No generic user/auth, live-event, polling-job, host-resource, audit or request-claim tables. Purpose-built tables (`orb_messages`, `orb_spawns`) are not job tables.

**PGlite.** `PI_ORB_DATABASE_KIND=pglite` embeds PostgreSQL-as-WebAssembly in the control plane, filesystem-backed at `PI_ORB_PGLITE_PATH` (`npm run dev:local`); tests use it in memory. Docker development uses a PostgreSQL server. Both drivers implement one `PostgreSQLClient` query/transaction boundary feeding the same stores, migrations, row mapping and SQL. PGlite is single-connection: it preserves CAS, atomic commits, deferred constraints, JSONB and recursive reconstruction for one process, but not pool behavior, network error mapping or multi-instance serialization; real-PostgreSQL tests own those. Rejected: the earlier SQLite adapter, which duplicated the schema and store with different semantics.

**Parameter intent.** node-postgres encodes from the JavaScript value; PGlite from the server-reported OID. Structured parameters therefore declare intent: `jsonParam()` for `json`/`jsonb`, `arrayParam()` for arrays. A shared prepare step rejects any bare array or plain object with a non-retryable `invariant` before the driver runs. `jsonParam(null)` binds SQL NULL. The store contract runs on both drivers; equal SQL text is not equal driver behavior (`docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`).

**`StoreError`.** `unavailable`: retryable outage. `corruption`: constraint violation (`23503`/`23505`/`23514`). `invariant`: our deterministic bug (SQLSTATE class `22`/`42` or the parameter guard); never retryable, HTTP 500 `internal`, and parks the loops that would retry it (`docs/lifecycle.md`).
