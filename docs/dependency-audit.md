# Dependency audit

**Evidence date: 2026-10-16, America/Los_Angeles.** The inventory is the pre-PR audit snapshot; the dated toolchain and Pi decisions below record subsequent approved upgrades. Registry/release queries were live; estimates are engineering judgment, not measured upgrade trials.

## Scope and reading guide

Pre-upgrade baseline: commit `563cb320aff03e3d3ac1c168d343b0eb580876dc`; main queries approximately 10:13–10:20 PDT; npm CLI latest rechecked at 10:25 PDT. All 10 npm manifests: root, seven workspaces, `scripts/native-mcp-exploration`, and `scripts/subagent-liveness`. The baseline declares **60 external names / 89 declarations; 42 names behind latest**. The cleanup-only snapshot after removing redundant Iron typings was **59 / 88 / 41** respectively, not the current toolchain inventory. The approved toolchain adds root `@types/node` and a root Vite declaration: **toolchain-only snapshot: 60 external names / 90 declarations** across the same ten manifests. The 41-behind-latest count belongs to the audit snapshot, not a new post-upgrade comparison. The tables cover retained dependency boundaries; aggregate counts belong only to the dated audit snapshot. Internal `@pi-orb/{control-plane,orb-runtime,web,luna,mock-openai,native-image,protocol}` packages are private local workspaces (`0.0.1`), not published third-party dependencies; their `*` links have no registry upgrade target.

Inventory versions, counts and security observations below describe that snapshot, not the upgraded lockfile.

`R` = root development tools; `C` = `apps/control-plane`; `O` = `apps/orb-runtime`; `W` = `apps/web`; `L` = `packages/luna`; `P` = `packages/protocol`; `I` = `packages/native-image`; `M` = standalone native-MCP exploration; `S` = standalone subagent-liveness experiment. Evidence paths use these prefixes. All versions are exact lock resolutions, **not manifest range minima**. Duplicate declarations share a row; distinct locked versions remain explicit. A nested copy is not necessarily the version imported by the declaring workspace.

“Latest” means the registry's stable `dist-tags.latest` observed that day, not `next`, beta, or a promise that a newer major suits this project. Package metadata is authoritative at `https://registry.npmjs.org/<URL-encoded-name>`; version records add `/<version>`. Release/migration sources below supply constraints beyond version comparison.

**Effort:** engineer-days for replacing the dependency with maintained in-house code at its present boundary, including tests; not deleting the feature or adopting a different library. `L/M/H` = low/medium/high correctness and maintenance risk. Family estimates overlap and must not be summed. Upgrade estimates are separate, assume one engineer familiar with the subsystem, and exclude unattended CI/build time and external approvals.

## Findings

- Keep domain-heavy infrastructure: agent harnesses, cryptography/authentication, PostgreSQL, terminal engines, charts, and the deterministic scheduler are not sensible hand replacements.
- Most patch/minor changes are bounded qualification work. Pi's patched family, browser/native artifacts, frontend toolchain majors, and auth/transport majors need coordinated validation; “same major” does not make them safe automatically.
- Peer satisfaction, executable invocation, and fixture-only usage are real dependency uses. An import-only dead-code scan is insufficient.
- The initial audit implemented cleanup only; subsequent approved toolchain changes are recorded separately below. Dated cleanup evidence: redundant `@types/hapi__iron` and the unreferenced vendored patch-package archive/verifier/source patch were removed in the accompanying review; patch-installation policy is specified in `docs/stack.md`. Iron ships declarations itself. The same dated cleanup removed transitional apt-transport-https from repository setup and its authored identity example: supported modern APT provides HTTPS natively. No replacement dependency or functionality loss; focused skill checks passed 30/30. Full qualification is recorded separately, not claimed here.

## Approved toolchain upgrade (2026-10-16)

The user chose Node **24.22.0 LTS**, Vite **8.3.4**, React plugin **6.1.2** and Vitest **5.0.5** to update the existing LTS/build/test stack together. This supersedes the smaller Vitest 4 maintenance candidate below; it does not approve Pi upgrades or hand replacements. Node archive checksums and exact Docker tags replace older/floating toolchain inputs; bundled npm is **11.19.1**.

Vite 8 changes bundling to Rolldown/Oxc and plugin 6 removes Babel features; this repository uses plain `react()` without Babel options. Vitest's sharding regression moves to `createVitest(options)`; worker/isolation/deadline policy stays intact. Root owns Vite for Vitest's peer, `@types/node` **24.19.2** for Node 24, and esbuild **0.28.2** for native build consumers; the latter must not depend on Chord hoisting. Explicit Chrome/Edge **107**, Firefox **104** and Safari **16** targets preserve the Vite 7 JavaScript/CSS baseline rather than narrowing support to Vite 8 defaults. Native optional artifacts require clean-lock/install/build validation; Node also requires native PTY and runtime E2E qualification. Current receipts and incomplete gates are separate from the cleanup baseline in `docs/testing.md`; no deployment is claimed.

## Approved Node LTS upgrade (2026-10-28)

Use Node **26.13.0 Lithium LTS**, bundled npm **11.20.0**, root `@types/node` **26.6.6** and its `undici-types` **8.9.0** dependency. No other npm resolutions change. Node 26's LTS status supersedes the October 16 Current-release rejection; its V8 has the Wasm wrapper lifetime protection absent from Node 24.22.1. Pin CI, Docker and the checksum-verified native archive together; retain native PTY, clean-install/build and runtime E2E gates. Incident/source limits: `docs/postmortems/2026-10-28-node-wasm-wrapper-lifetime.md`; qualification: `docs/testing.md`. The inventory tables below remain historical.

## Approved Pi upgrade and native adapter (2026-10-16)

The user separately approved **Pi 1.3.0 plus native Durable code-mode**, not merely a dependency bump retaining the custom wrapper. Native nested tasks and deterministic journals provide restart continuity and remove first-party orchestration; pi-orb retains authorization, cancellation/resource limits, charts and scoped private artifacts. Native state fits existing JSON task/document storage; completed history is preserved without compatibility staging for unfinished custom work. Future native success-only, rewind/as-of-fork store semantics are approved; store cutover proposal: `docs/open-questions.md`, question 81. Design: `docs/pi-durable-evaluation.md`; install, patch and test evidence: `docs/testing.md`.

Current patch installation uses three central patches: Pi AI, codemode and Durable. Pi runs centrally; runtime hosts contain execution services and native Claude. Guest/native installs apply no patches; loaded-closure checks verify zero patched files. Exact patch/file provenance is in `patches/pi-codemode.PROVENANCE.md` and `patches/pi-durable.PROVENANCE.md`; install contract: `docs/stack.md`. Strict raw MCP validation preserves explicit null and defaults only undefined to `{}`. Completed native receipts are reused; already-admitted safe pending children can retry with current authorization/environment checks, independently of parent replay refusal. No physical exactly-once promise or custom replay orchestrator. Exact-source receipts remain in `docs/testing.md`.

The inventory rows, estimates and text-only patch probes below remain the **pre-upgrade audit snapshot**, not current dependency or qualification claims. The earlier toolchain-only approval did not authorize Pi; this separate decision does. No external state reset or deployment is included.

## Direct npm inventory (pre-upgrade snapshot)

### Harnesses, execution, shared contracts

| Name: locked → latest | Scope; usage evidence | Hand replacement; prudence | Upgrade effort / constraint |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk`: `0.3.300 → 0.3.301` | C/O; `O/src/claude/agent.ts`, `C/src/adapters/spawn-models.ts`: query, sessions, tools, hooks | 90–180d+/H; retain harness | 1–3d/M with CLI; new per-tool MCP policy and disk-full error classification; native-worker/recovery tests [Claude]. |
| `@anthropic-ai/claude-code`: `2.1.300 → 2.1.301` | C; `src/adapters/claude-auth-pty.ts` resolves executable and runs `setup-token` | 10–20d/H login-only, 60–120d+ whole CLI; retain | 1–3d/M paired; **hardcoded 2.1.300 guard must change**, PTY/login parser/process cleanup qualification [Claude]. |
| `@earendil-works/chord`: `1.1.0 → 1.3.0` | C; `src/process-agent-composition.ts`, `adapters/durable/agent.ts`: context/cancellation/replicated state | 15–30d/H; retain | 1–3d marginal; protocol v2/Ref/Implementation/codeVersion changes, inspect used surfaces [Pi]. |
| `@earendil-works/pi-ai`: `1.1.0 → 1.3.0` | C/L/M/S; `L/src/index.ts`, C model adapters, experiment providers: streaming/auth/catalog/usage | 60–120d+/H whole surface; Luna-only 10–20d; retain | 2–4d marginal; removed frame APIs, provider/model behavior; rebase auth/diagnostic patch [Pi]. |
| `@earendil-works/pi-codemode`: `1.1.0 → 1.3.0` | C; `src/adapters/durable/tools/codemode.ts`, `tools/vendor/description.ts`: sandbox/tool bridge | 30–60d+/H; retain | 2–4d marginal; imported declaration helpers removed; result/close no longer proves worker exit; preserve budgets/admission [Pi]. |
| `@earendil-works/pi-coding-agent`: `1.1.0 → 1.3.0` | C; ModelRuntime/auth/skill helpers in central composition | 90–180d+/H; retain | High; coupled Pi estimate below; custom-turn/startup/abort and resumed-tool changes, sealed patch conflict [Pi]. |
| `@earendil-works/pi-durable`: `1.1.0 → 1.3.0` | C/O; C durable agent/storage, `O/src/execution/{server,boot,line-reader}.ts` execution environment | 60–120d+/H scheduler; 15–30d env-only; retain | 3–6d marginal C, 2–5d env-only O; removed StorageRejected, task v2, content→output; state implications [Pi]. |
| `@earendil-works/pi-mcp`: `1.1.0 → 1.3.0` | C/M; durable MCP adapter and native retry/transport characterization | 15–30d/H; retain | 0.5–2d marginal; structuredContent becomes unknown, signal/send and issuer/cancel-retry behavior [Pi]. |
| `@modelcontextprotocol/sdk`: `1.32.0 → 1.32.1` | O; `src/claude/mcp.ts`: legacy bridge Client/server/transports/schemas; Claude peer | 25–50d/H; retain | 0.5–1d/L maintenance update; not migration to split v2 packages; see MCP distinction below [MCP]. |
| `@modelcontextprotocol/client`: `2.2.0 → 2.3.1` | C; `src/adapters/{mcp-probe,mcp-oauth}.ts`: probe/discovery/OAuth, distinct from Pi MCP | 15–30d/H; retain | 0.5–2d/M; 2.3 redirect/SSE-parser constraints, test custom fetch/DNS/OAuth guards [MCP]. |
| `agent-browser`: `0.33.2 → 0.39.1` | O; Dockerfile binary link and native Claude/central environment prompt instructions | 30–60d+/H; retain; CLI-only is intentional | 2–4d/M; Node≥24, native launcher/artifacts with scripts disabled, shared sessions/persistent refs/outcome_unknown [Browser]. |
| `node-pty`: `1.1.0 → 1.1.0` | C/O; Claude auth PTY, `O/src/terminal/manager.ts`; native rebuild/permissions scripts | 30–60d+/H; retain; pipes are not PTYs | Current stable; exclude 1.2 beta. Any Node/image change needs ABI rebuild, spawn/resize/signal/exit checks. |
| `determined`: `0.4.1 → 0.4.1` | C/O/I; production NoSimulationTask/task boundaries; I imports only in DST tests | 30–60d+/H; retain scheduler/replay/failpoints | Current. I declaration looks dev-only (<0.5d classification), not unused; C/O production use remains. |
| `neverthrow`: `8.2.0 → 8.2.0` | C/O/W/L/P/I/M/S; Result/ResultAsync throughout adapters and shared validators | 10–20d/M shared migration; retain project error contract | Current; a two-case union does not replace async combinators/inference and all exported consumers. |
| `typebox`: `1.3.27 → 1.4.0` | C/O/W/P; `P/src/{frames,control-plane-api,chart}.ts`, boundary Check/Errors | 20–40d/H shared schemas/inference/validation; retain | 1–3d/M shared. Already unscoped 1.x, ESM/TS6–7+. No verified 1.4 migration notes; Pi1.3 pins 1.3.27 internally. |
| `zod`: `4.5.4 → 4.6.7` | C; durable resource-context and PG resource-snapshots; Claude SDK peer `^4` | 0.5–2d/M convert local schemas to TypeBox; peer still requires Zod | 0.25–1d/L–M; check bounds/defaults/unknown properties; no version-specific release notes verified. |

### HTTP, authentication, storage

| Name: locked → latest | Scope; usage evidence | Hand replacement; prudence | Upgrade effort / constraint |
|---|---|---|---|
| `fastify`: `5.12.5 → 5.12.7` | C/O; C main/http routes, O http/execution servers: hooks/body/close/errors | 20–40d/H across both; retain | 0.5–1d/L with plugins; v5 already selected, not a v4 migration; validate header/schema/error/close behavior [HTTP]. |
| `@fastify/static`: `10.1.2 → 10.1.6` | C; `src/http/web-assets.ts`: assets/cache/path handling | 2–4d/M; retain safe range/HEAD/MIME semantics | 0.25–0.5d/L; latest publishing-only notes do not prove intermediate compatibility; asset/missing-path tests [HTTP]. |
| `@fastify/websocket`: `11.3.0 → 11.3.4` | C/O; live proxy and http/execution/terminal upgrades | 3–5d/M retaining ws; retain framework integration | 0.5–1d/L; intermediate socket/hook error and listener fixes; handshake/error/close tests [HTTP]. |
| `ws`: root `8.21.1`, M `8.22.0`, S `8.21.3 → 8.22.0` | C/O/W declarations; C live proxy; O tests; W `dev/mock-backend.ts` server/client | 15–30d/H server protocol; retain (native client is no server) | 0.5–1d/L shared; protocols option/invalid-close state fix. O declaration appears dev-only; plugin still brings production ws [HTTP]. |
| `@types/ws`: `8.18.1 → 8.18.2` | C/O/W dev; proxy/plugin/socket test declarations and W dev config | 1–3d/M; retain implicit module typing | <0.5d/L; typecheck plugins, callbacks, both web configs. |
| `undici`: direct `7.29.1`, Pi-nested `8.10.2 → 8.12.2` | C; MCP probe/OAuth custom Agent enforces connect-time DNS/SSRF policy; nested copy in all locks | 10–20d/H; native fetch alone cannot replace custom dispatcher | 1–3d/M major8; HTTP/2 default and dispatcher/handler changes. 7.30.1 security backport: 0.5–1d candidate; nested owner distinct [Undici]. |
| `ipaddr.js`: C-selected `2.2.0`; other root copies `2.4.0`, `1.9.1 → 2.5.0` | C; `src/adapters/mcp-probe.ts` process/range SSRF classification | 3–5d/H; retain IPv4/IPv6/mapped/reserved handling | 0.5–1d/M; reserved-range and strict-IPv6 changes require public/private/mapped boundary tests [IP]. |
| `cookie`: direct `1.1.1`, nested Express `0.7.2 → 2.0.1` | C; `src/http/auth-routes.ts` session parse/serialize | 1–2d/H on auth boundary; retain | 0.5–1d/M; Node≥22, new parseCookie/stringifySetCookie object API; inspect latest exports; no verified changelog [Cookie]. |
| `@hapi/iron`: `7.0.1 → 7.0.1` | C; `src/adapters/sealed-auth-cookies.ts` authenticated sealed cookies | 3–6d/H plus security review; retain | Current; ships `lib/index.d.ts`; runtime package remains required. |
| `@types/hapi__iron`: **removed** baseline `5.1.0 → 6.0.1` | C dev baseline; redundant because Iron supplies declarations; latest types deprecated stub | No replacement; removal 0.1–0.25d/L | Dated cleanup, not an upgrade to stub. |
| `openid-client`: `6.8.8 → 6.8.8` | C; Google application auth: state/nonce/PKCE/code grant/validation | 10–20d/H; retain secure OIDC flow | Current; ESM/WebCrypto/fetch support still matters even without engines metadata. |
| `google-auth-library`: root `10.5.0`, M/S `10.9.1 → 11.3.1` | C; Google application auth, GCE API, GCS; ADC/token/key handling | 10–20d/H; retain; distinct from browser OIDC | 0.5–2d/M; major11 Node≥22 satisfied by Node24; real ADC/login/machine-token/GCE/GCS tests [Google]. |
| `@google-cloud/secret-manager`: `6.3.0 → 7.2.0` | C; `src/adapters/secrets/gsm-store.ts` generated service client | 2–4d/M narrow REST adapter retaining Google auth; possible, not unused | 0.5–1.5d/M; major7 Node≥22; test auth, absence/conflict, deadlines/retries [Google]. |
| `pg`: `8.22.0 → 8.23.1` | C; `src/adapters/pg/client.ts`, migration contracts: network PostgreSQL | 30–60d+/H wire/TLS/SCRAM/pool; retain | 0.5–1d/L–M with types; query pipelining need not be adopted; real network-PG tests [DB]. |
| `@types/pg`: `8.20.0 → 8.23.1` | C dev; pg client/pool/query declarations | 2–4d/M; retain | 0.25–0.5d/L with pg; types may tighten. |
| `@electric-sql/pglite`: `0.5.4 → 0.5.10` | C; `src/adapters/pg/pglite-client.ts`: supported embedded local database | 100–250d+/H engine; retain, not just tests | 0.5–2d/M; includes PG18.6 engine refresh, close/dump/transaction fixes; both backends/data-dir contracts [DB]. |

### Browser rendering and Markdown

| Name: locked → latest | Scope; usage evidence | Hand replacement; prudence | Upgrade effort / constraint |
|---|---|---|---|
| `react`: `19.2.7 → 19.3.1`; `react-dom`: `19.2.7 → 19.3.1` | W; App/hooks/JSX, main createRoot, portals and SSR tests | 60–120d+/H shared framework; retain | 0.5–2d/M family; DOM peers require React ^19.3.1. 19.3.0 notes reviewed, **19.3.1-specific detail unverified** [React]. |
| `@types/react`: `19.2.17 → 19.3.0`; `@types/react-dom`: `19.2.3 → 19.3.0` | W dev; JSX/hooks/events/client/portal/server module resolution | 10–20d+/M React, 1–3d DOM; retain | 0.25–1d/L–M group; DOM types peer ^19.3.0; compile portals/SSR. |
| `@wterm/dom`: `0.3.2 → 0.5.4` | W; `src/components/OrbTerminal.tsx` WTerm type and required React peer | 20–40d/H DOM terminal; retain | 1–3d/M **whole family**, pre-1.0 minor changes; exact DOM peer alignment [Terminal]. |
| `@wterm/ghostty`: `0.3.2 → 0.5.4` | W; same component imports GhosttyCore and `ghostty-vt.wasm?url` | 60–120d+/H VT/WASM core; retain | Same family; validate built WASM URL, Unicode/alternate-screen/resize [Terminal]. |
| `@wterm/react`: `0.3.2 → 0.5.4` | W; Terminal/useTerminal and main CSS | 2–4d/M wrapper retaining DOM/core; little benefit | Same family; rendering/fractional rows/history-scroll changes, React18/19 peers [Terminal]. |
| `linkify-react`: `4.3.3 → 4.3.3`; `linkifyjs`: `4.3.3 → 4.3.3` | W; `src/components/ChatText.tsx` wrapper/Opts; exact required JS peer | 0.5–1.5d/L wrapper; 3–6d/M tokenizer; retain | Current; keep exact pair; regex-only URL replacement changes punctuation/boundaries. |
| `react-markdown`: `10.1.0 → 10.1.0`; `remark-gfm`: `4.0.1 → 4.0.1` | W; `src/components/ChatMarkdown.tsx` safe AST-to-React, custom links/code/tables | 10–20d/H renderer, 5–10d/M GFM extensions; retain | Current; raw HTML rendering is not an equivalent safe replacement. |
| `vega`: `6.4.0 → 6.4.0` | W; required embed/Lite runtime peer even without direct source import | 15–30d/H current SVG/interactions; retain | Current; no import does not mean unused. |
| `vega-embed`: `7.3.0 → 7.3.0` | W; `src/lib/chart-render.ts` embed/View/finalize lifecycle | 1–3d/M wrapper using retained Vega/Lite; plausible reduction | Current; preserve custom tooltip, lifecycle/errors; no approved removal. |
| `vega-lite`: `6.5.0 → 6.5.0` | W; specs consumed by embed, direct compile in chart-spec tests; required peer | 5–10d/M lower-level Vega specs; 15–30d/H hand SVG; retain | Current; Node≥22 for tooling. Runtime-used, not merely a test dependency. |
| `mdast-util-from-markdown`: `2.0.3 → 2.1.0` | P; `src/reasoning-headline.ts`: AST/source spans | 20–40d/H used parser behavior, 60–100d+ full parser; retain | 0.5–1d/L; listener/list/compiler changes; nesting/offset/UTF-8 regressions [Markdown]. |
| `mdast-util-gfm`: `3.1.0 → 3.1.0`; `micromark-extension-gfm`: `3.0.0 → 3.0.0` | P; same module: AST extension **and** syntax extension | 10–20d/H shared GFM work; retain | Current; pair with parser2. Removing GFM changes headline semantics. |
| `mdast-util-to-string`: `4.0.0 → 4.0.0` | P; same module: text/image-alt traversal, includeHtml:false | 0.5–1.5d/L local visitor plausible | Current; parser also depends on it, so replacing direct helper may not shrink graph. |
| `@types/mdast`: `4.0.4 → 4.0.4` | P dev; same module imports **mdast** RootContent/PhrasingContent | 0.5–1d/M narrow types; retain ownership | Current; removing declaration can merely hide reliance on parser's transitive typings. |

### Development tools and standalone execution

| Name: locked → latest | Scope; usage evidence | Hand replacement; prudence | Upgrade effort / constraint |
|---|---|---|---|
| `@biomejs/biome`: `2.5.4 → 2.5.15` | R; lint/format, biome.json, custom `lint/no-throw.grit` | 60–120d+/H formatter/linter/rule parity; retain | 0.25–1d/L; pin+lock+schema URL together, review new diagnostics and Grit behavior. |
| `@playwright/test`: `1.63.0 → 1.64.1` | R; E2E browser engines/types/**assertions**, while Vitest runs tests | 60–120d+/H automation; retain | 1–3d/M qualification; reinstall matching browser revisions; 1.64.1 fixes Chromium cross-origin redirect regression [Tools]. |
| `typescript`: `7.0.2 → 7.0.2` | R; all workspace/e2e tsc, strict erasable-only contract | 250d+/H checker; retain | Current; native Node type stripping is not typechecking. |
| `vitest`: `4.1.11 → 5.0.5` | R; unit/DST/E2E pools/shards/mocks/config | 20–40d+/H migrate tests to hand/Node harness; retain | 2–5d/M major: mocks/timers/polling/hoisting/reporters/worker IDs; Node ^22.12/^24/≥26, Vite≥6.4. **4.1.12** is smaller maintained-line candidate [Tools]. |
| `vite`: `7.3.6 → 8.3.4`; `@vitejs/plugin-react`: `4.7.0 → 6.1.2` | W dev; vite.config.ts, dev/build, fixture middleware/proxy/HMR | 20–40d/H Vite, 3–6d/M refresh plugin; retain | 1–3d/M together; plugin6 peers Vite8, removes Babel features; Rolldown/Oxc replaces Rollup/esbuild, baseline browser changes [Build]. |
| `tsx`: `4.23.15 → 4.23.15` | M; explicit node --import tsx test script loads root TypeScript fixtures | 10–20d/H loader; retain current execution contract | Current; Node stripping alternative needs 1–3d resolution/type-import qualification, not a handwritten loader. |

`packages/mock-openai` has no external declarations; it already uses platform primitives. Shared local mock configuration is imported by production composition, so blindly making that workspace dev-only breaks packaging. Historical standalone characterization receipts are separate from current workspace qualification.

### Coupled migration constraints and reduction findings

**Pi means the upstream package family, not only `pi-durable`.** Central Durable still uses coding-agent model/auth/skill helpers and Pi AI inference/provider APIs; Luna uses Pi AI for auxiliary inference. Hosts supply execution RPC or native Claude. Placement does not imply eliminating all SDK packages.

**Pi upgrade constraints:** native task schemas, replay classification, storage failures and image/resource accounting require coordinated adapter qualification. Preserve cancellation/auth cleanup, sanitized provider diagnostics, scoped MCP callability, CPU/memory/output limits and receipt/history atomicity. Discuss persisted-state changes before implementation; use direct POC cutover, not compatibility staging. Patch/file seals and exact-source checks are authoritative (`docs/stack.md`, `docs/testing.md`).

MCP1's maintenance patch does not add spec2026-07-28 support. SDK1 supports spec2025-11-25; upstream states bug/security maintenance for at least six months after v2's 2026-07-27 release. Moving the Claude bridge to split v2 client/server is **3–7d/M**, separate from 1.32.1; Claude still peers on SDK1, so coexistence/interop remains relevant [MCP].

**Chart layers:** Vega renders charts; Vega-Lite compiles declarative specs into Vega; `vega-embed` mounts and manages the resulting View. A first-party mounting adapter could replace embed while retaining the engine and compiler.

**Secret Manager replacement means `@google-cloud/secret-manager`:** a first-party REST adapter would replace its generated client, retaining `google-auth-library`. Equivalent behavior includes all four operations, pagination, version/error semantics, deadlines and safe retries, plus migrating the root-backed client call in `scripts/native-mcp-exploration/live-qualification/oauth-public-lookup.mjs`. Protobuf and Google auth remain through Pi's Google provider in all three graphs.

The table distinguishes removing a package from **all three graphs** from removing only our declaration/import. All seven targets are absent from both standalone locks; root reverse edges decide elimination. Estimates cover equivalent used behavior and tests, not reproducing unused library features. These are findings, **not approved or implemented replacements**.

| Narrow replacement | Package elimination across all three graphs | Retained owners / capability; effort |
|---|---|---|
| `linkify-react` wrapper | Yes: `linkify-react` | Keep `linkifyjs` tokenizer and React; 0.5–1.5d/L. |
| `vega-embed` mounting wrapper | Yes: `vega-embed` | Keep Vega/Lite and chart interactions, tooltips, resize/finalize/error handling; 1–3d/M. |
| `@google-cloud/secret-manager` client | Yes: it plus `google-gax`, `@grpc/grpc-js`, `@grpc/proto-loader` | Keep Google auth and `protobufjs`; both source callers must migrate; 2–4d/M. |
| `@wterm/react` lifecycle wrapper | Yes: `@wterm/react` | Keep DOM/Ghostty/WASM, React and terminal CSS; preserve async init/destroy/resize; 2–4d/M. |
| `@fastify/static` asset adapter | Yes: `@fastify/static` | Keep Fastify; preserve containment, MIME, GET/HEAD, caching and missing-resource routing; 2–4d/M. |
| `cookie` session helper | **No:** only our direct edge | Fastify's `light-my-request` and MCP's Express retain copies; 1–2d/H. |
| `mdast-util-to-string` headline visitor | **No:** only our direct edge | `mdast-util-from-markdown` and `mdast-util-to-markdown` retain it; 0.5–1.5d/L. |

These are package-name removals, not measured install-size savings or lock-record counts; shared/nested dependencies remain. Replacing safe parsers, OAuth/crypto, scheduler, terminal engines, or harnesses to reduce a name count is not prudent.

Baseline manifest ownership findings: runtime imports Pi AI/agent-core/Chord without owning declarations (plus a pi-mcp test import); native-image acceptance/build and fork reproduction consume hoisted esbuild (`0.28.2`, current). Baseline Node typings resolved transitively to **26.1.1** against Node24; latest overall **26.6.5** was not the right target. The approved toolchain pins root `@types/node` **24.19.2**. Runtime `ws` and native-image `determined` have real test-only direct use and plausible dev reclassification; neither becomes removed from the relevant production/plugin/DST graphs. Remaining ownership work is tracked only in `TODO.md`.

### Authoritative npm migration sources

[Pi]: https://github.com/earendil-works/pi/tree/main/packages
[Claude]: https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.301
[MCP]: https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2
[Browser]: https://github.com/vercel-labs/agent-browser/releases
[HTTP]: https://github.com/fastify/fastify-websocket/compare/v11.3.0...v11.3.4
[Undici]: https://github.com/nodejs/undici/releases/tag/v8.12.2
[IP]: https://github.com/whitequark/ipaddr.js/blob/master/Changes.md
[Cookie]: https://github.com/jshttp/cookie/blob/master/README.md
[Google]: https://github.com/googleapis/google-cloud-node/blob/main/packages/google-cloud-secretmanager/CHANGELOG.md
[DB]: https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md
[React]: https://github.com/facebook/react/blob/main/CHANGELOG.md
[Terminal]: https://github.com/vercel-labs/wterm/blob/main/CHANGELOG.md
[Markdown]: https://github.com/syntax-tree/mdast-util-from-markdown/releases/tag/2.1.0
[Tools]: https://github.com/vitest-dev/vitest/releases/tag/v5.0.0
[Build]: https://vite.dev/guide/migration

Version/engine/peer facts come from live npm packuments. Pi constraints come from released 1.2/1.3 sections of published package changelogs; [coding-agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md), [Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md), [codemode](https://github.com/earendil-works/pi/blob/main/packages/codemode/CHANGELOG.md), [Chord](https://github.com/earendil-works/pi/blob/main/packages/chord/CHANGELOG.md), [AI](https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md), [MCP](https://github.com/earendil-works/pi/blob/main/packages/mcp/CHANGELOG.md). Other specific evidence: [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [MCP1.32.1](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.1), [MCP2.3](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.0), [Fastify compare](https://github.com/fastify/fastify/compare/v5.12.5...v5.12.7), [ws8.22](https://github.com/websockets/ws/releases/tag/8.22.0), [React plugin changelog](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/CHANGELOG.md), [Google Auth changelog](https://github.com/googleapis/google-cloud-node/blob/main/core/packages/google-auth-library-nodejs/CHANGELOG.md), [pg changelog](https://github.com/brianc/node-postgres/blob/master/CHANGELOG.md), [Playwright1.64.1](https://github.com/microsoft/playwright/releases/tag/v1.64.1). Mutable changelogs were read for released sections only; where no version-specific notes were verified, estimates explicitly say so.

## External infrastructure and tools

Source evidence: `infra/native-vm/install.sh`, `infra/native-vm/PACKAGES.md`, application/foundation Terraform roots and locks, runtime/control-plane Dockerfiles, `.agents/setup`, `.github/workflows/*`, and referenced build/release helpers. Floating inputs have **no source-provable installed exact version**; the right-hand value is available upstream, not a claim about the deployed image. OS candidates below target Debian12 amd64, not Ubuntu runner patches. Hand estimates cover equivalent used capability; replacing a platform wholesale is generally ≥250d/H and imprudent.

### Platforms, providers, downloaded tools

| Input: current source selection → verified latest | Need / usage | Hand replacement; prudence | Upgrade effort / concrete constraint |
|---|---|---|---|
| Node `24.6.0` native/CI; Docker `24-bookworm-slim` floating → **24.22.0 LTS / 26.12.0 Current** | TS execution, builds, tests, runtime | ≥250d/H; retain | 1–3d/M same-LTS: URL/SHA/workflows/contracts, PTY offline headers/ABI, stripping/flags, full E2E; floating Docker can differ already [Node](https://nodejs.org/dist/index.json). |
| npm bundled, audit client **11.5.1**, no packageManager pin → Node24.22 bundle **11.19.1**, Node26.12 **11.20.0**; registry **12.2.0** | Lock/workspace/postinstall behavior | 30–60d/H used installer; retain | 0.5–1d/M via Node; latest requires ^22.22.2/ ^24.15/ ≥26 (**not current24.6**). Verify lifecycle policy/three clean installs; [registry](https://registry.npmjs.org/npm) latest differs from bundle. |
| OpenTofu `1.12.6` checksum ZIP → **1.13.1** | CI/infra declarative state and planning | 60–120d+/H used IaC; retain | 1–2d/M tool+checksums at both workflow sites, validate mocks; evaluate existing import-stripping crash workaround, not blindly remove [release](https://github.com/opentofu/opentofu/releases/tag/v1.13.1). |
| `opentofu/google`: app **7.21.0**, foundation **6.50.0** (`~>6.0`) → **8.7.0** | IAM/Run/SQL/network/WIF/storage resources; independent roots | 60–120d+/H; retain | 3–7d/H schema/default/7+8 guide review, platform lock checksums, mock tests and independent no-replacement plans. Registry API403; [publisher release](https://github.com/opentofu/terraform-provider-google/releases/tag/v8.7.0) verified, registry availability not. |
| `opentofu/random`: **3.9.0** (`~>3.6`) → **3.9.1** | Stable managed DB password/state | 0.5–1d/H code but dangerous password churn; retain | 0.5–1d/M lock/init/plan, no accidental replacement; ~>3.6 permits later3.x [release](https://github.com/opentofu/terraform-provider-random/releases/tag/v3.9.1). |
| gcloud deploy **583.0.0**, guest/hook APT floating → **589.0.0**, APT589.0.0-0 | Cloud release/image/IAP/identity/boot diagnostics | 30–60d+/H REST/auth/SSH subset; retain | 1–2d/M auth exec credentials, beta/SSH/SCP/IAP and JSON contracts; hook skips installed clients [channel](https://dl.google.com/dl/cloudsdk/channels/rapid/components-2.json). |
| gh floating APT → **2.102.0** | Prescribed agent GitHub client/auth shim | 10–20d/M used commands; retain | 0.5–1d/M rebuild, broker env/no hosts.yml, PR/repo operations [release](https://github.com/cli/cli/releases/tag/v2.102.0). |
| Tailscale floating stable APT → **1.104.1** | Runtime userspace preview network | ≥250d/H overlay/security; retain | 1–2d/M rebuild, no-TUN daemon supervision/reachability/credential lifecycle [release](https://github.com/tailscale/tailscale/releases/tag/v1.104.1). |
| Chromium floating bookworm-security → **155.0.8059.79-1~deb12u1** | agent-browser engine, **not Playwright's downloaded engines** | ≥250d/H; retain | 0.5–1d/M rebuild/smoke launcher/snapshots; CLI/browser compatibility can drift [security index](https://security.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz). |
| Docker Engine/CLI **5:29.1.3-1~debian.12~bookworm → 5:29.9.1-1~debian.12~bookworm** | Native user containers and retention acceptance | ≥250d/H; retain | 2–4d/H pair update, API/storage review, reboot/stop/start retained images/containers/volumes/networks and /workspace/docker [APT](https://download.docker.com/linux/debian/dists/bookworm/stable/binary-amd64/Packages.gz). |
| containerd.io **2.3.4-2~debian.12~bookworm → 2.4.2-2~debian.12~bookworm** | Native Docker runtime/storage | ≥250d/H; retain | 1–3d/H with Docker; config schema/defaults and /workspace/containerd mount/retention [same APT](https://download.docker.com/linux/debian/dists/bookworm/stable/binary-amd64/Packages.gz). |
| buildx/compose plugins floating → **0.38.0-1~debian.12~bookworm / 5.6.0-1~debian.12~bookworm** | Image/cache builds; compose up--wait retention fixture | 60–120d+/H build, 10–20d/M compose subset; retain | 1–2d/M builds/cache/load/provenance, compose seed/reboot/verify; Buildx action does not pin binary/BuildKit [same APT](https://download.docker.com/linux/debian/dists/bookworm/stable/binary-amd64/Packages.gz). |
| rustup **1.29.0 → 1.29.1** (per-arch SHA) | Prescribed compiler bootstrap/proxies; no preinstalled rustc pin | 10–20d/H toolchain manager; retain | 0.5–1d/L–M x64/arm64 URLs/hashes, proxies/permissions, durable CARGO_HOME/RUSTUP_HOME [manifest](https://static.rust-lang.org/rustup/release-stable.toml). |
| Debian **12 bookworm**, GCE **debian-12-bookworm-v20260902** → stable **13.7 trixie** | Guest/systemd/security/native-addon base | ≥250d/H; retain | 3–7d/H major baseline qualification; third-party APT URLs, pins, SSH/guest-agent/ext4/native ABI. Latest GCE bookworm image **not queried**; don't infer from date [stable metadata](https://deb.debian.org/debian/dists/stable/Release). |
| GitHub runner **ubuntu-24.04** → Ubuntu LTS **26.04.1** | CI host and system libraries | ≥250d/H OS; retain supported label | 1–3d/H if new runner label available (**unverified**); APT/Docker/browser qualification; fixed label still changes image [Ubuntu metadata](https://changelogs.ubuntu.com/meta-release-lts). |
| PostgreSQL Docker **16**, Cloud SQL **POSTGRES_16** → **18.6**; maintained16 **16.15** | Durable DB/local/CI backend | ≥250d/H; retain supported16 | 1–2d/M minor, 5–10d/H major plus owner approval: backup/restore/pg_upgrade/CloudSQL plan, extensions/migrations. Never attach a PG16 volume to PG18. 16 support to2028-11-09 [versions](https://www.postgresql.org/versions.json). |
| Alpine fixture **3.22 → 3.24.2**, current branch **3.22.6** | Tiny shell/sleep/sentinel retention container | ≥250d/H OS; swapping image <0.5d but no benefit | <0.5d/L branch refresh/digest; retained offline-image acceptance [releases](https://alpinelinux.org/releases.json). |

Cloud services (GCE, Cloud Run, Cloud SQL, Secret Manager, IAM/STS, GCS and Artifact Registry), GitHub and model/OAuth endpoints are managed external contracts, not locally version-locked libraries with a meaningful “latest stable.” Their adapters, auth, quotas, retention and failure semantics still require live qualification. Provider/tool versions do not version those services. Any persisted-state/provider-plan change needs discussion before implementation; no apply is authorized here.

### Explicit distro packages

All source selections float unless stated; available signed-repository candidates are shown, **not an installed-version audit or newest upstream-source comparison**. Prefer supported distro security updates over bespoke upstream builds. Shared 0.5–2d/M rebuild/boot/acceptance qualification applies to each group; hand estimates are for used capability, not full GNU/OpenSSH parity.

| Names: available Debian12 candidates | Need / usage | Hand effort / prudence; upgrade constraint |
|---|---|---|
| git **1:2.39.5-0+deb12u3** | Checkout/worktrees/credential helper/**sealed git apply installer** | 20–40d+/H; retain even in control-plane install stage. |
| ca-certificates **20250419~deb12u1**; curl **7.88.1-10+deb12u15** | TLS trust/download/smoke/auth helpers | 20–40d+/H trust+HTTP subset; retain; no insecure TLS bypass. |
| apt-transport-https baseline candidate **2.6.1**, **removed 2026-10-16** | Redundant setup/example package; supported modern APT supplies HTTPS | No replacement; <0.5d/L removal implemented, HTTPS behavior retained; focused skills30/30, full qualification separate. |
| gnupg **2.2.40-1.1+deb12u2** | Setup dearmors Google APT key | 10–20d+/H crypto; retain current pipeline; supported armored .asc can avoid dearmor, not signature verification. |
| python3/python3-venv **3.11.2-1+b1**; python-is-python3 **3.11.2-1+deb12u1** | Infra stdlib scripts, addon helper, prescribed guest Python/venv/alias | ≥250d/H language, <0.5d alias; retain; tomllib needs≥3.11. Metapackage version is not exact interpreter patch. |
| build-essential **12.9**; pkg-config **1.8.1-1** | PTY/project native compilation | ≥250d/H compiler tools; retain guest capability; control-plane already multistage/build-only. |
| ripgrep **13.0.0-4+b2** | Prescribed agent search | 10–20d+/M used search semantics/performance; retain. |
| zip **3.0-13+deb12u1**; unzip **6.0-28+deb12u1**; xz-utils **5.4.1-1+deb12u2** | Guest archives, tofu ZIP, Node tar extraction | 10–20d+/H format subset; retain; build-only xz savings minor. |
| sudo **1.9.13p3-1+deb12u4** | Non-root hooks/guest capability | 10–20d+/H privilege tool; retain unless deliberately changing trusted-agent privilege model. |
| iproute2 **6.1.0-3**; util-linux **2.38.1-5+deb12u3**; openssl **3.0.22-1~deb12u1** | Namespace/mount/TLS/native synthetic acceptance | 30–60d+/H used platform subset; retain; filesystem/host acceptance on update. |
| jq **1.6-2.1+deb12u2**; uuid-runtime **2.38.1-5+deb12u3** | Release/smoke JSON and uuidgen | 1–3d/M migrate many shell uses to Python; minimal savings, retain. Don't assume guest images include deploy-only tools. |
| systemd **252.39-1~deb12u2**; openssh-server **1:9.2p1-2+deb12u10**; guest-agent **20211116.00-6+b7** | Inherited/native boot/mount ordering, IAP/SSH guest identity | ≥250d/H; retain. Actual GCE guest-agent may use Google's repo, not Debian candidate; verify host-key ownership. |

Sources: [bookworm main](https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.xz), [security](https://security.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz), [updates](https://deb.debian.org/debian/dists/bookworm-updates/main/binary-amd64/Packages.xz), [gh APT](https://cli.github.com/packages/dists/stable/main/binary-amd64/Packages), [Tailscale APT](https://pkgs.tailscale.com/stable/debian/dists/bookworm/main/binary-amd64/Packages), [Google APT](https://packages.cloud.google.com/apt/dists/cloud-sdk/main/binary-amd64/Packages). Audit index downloads were not signature-authenticated/reinstalled; normal APT verifies signed Release metadata. `infra/runtime_apt.sh` checks package size/hash with phase diagnostics. Third-party keys are HTTPS-fetched without separately pinned fingerprints; signatures trust those keys.

### GitHub Actions

All have actual `.github/workflows/*` consumers. SHA prefixes below identify the current source pin; `@v5` is mutable. Hand estimates cover this project's shell/API equivalent, not a reusable action; maintaining checkout/auth/cache security is usually a worse trade. Updated actions still need runner-minimum and credential-policy review.

| Action: current → latest stable publisher release | Need / hand effort | Upgrade effort / constraint |
|---|---|---|
| actions/checkout: CI **@v5**, deploy **fbc6f3992d24…** → [**v7.0.1**](https://github.com/actions/checkout/releases/tag/v7.0.1) | Exact-source checkout; 2–4d/M shell equivalent, retain | 0.5–1d/M credentials/safe.directory/detached SHA/fetch-depth/runner review; consistent reviewed pins. |
| actions/setup-node: **@v5 / a0853c245446…** → [**v7.1.0**](https://github.com/actions/setup-node/releases/tag/v7.1.0) | Runtime/npm cache; 1–3d/M equivalent, retain | 0.5–1d/M v7 ESM/NODE_AUTH_TOKEN/cache inputs/runner; retain exact Node policy. |
| actions/upload-artifact: **043fb46d1a93…** (#v7.0.1) → [**v7.0.2**](https://github.com/actions/upload-artifact/releases/tag/v7.0.2) | Failure evidence; 3–5d/H protocol/retention equivalent, retain | <0.5d/L patch + exact-SHA workflow contracts; preserve allowlists/secret exclusions/immutable names. |
| actions/cache: **0400d5f644dc…** (#v4.2.4) → [**v6.1.0**](https://github.com/actions/cache/releases/tag/v6.1.0) | Browser binaries; 2–4d/M cache client; disabling slower but feasible | 0.5–1d/M runner/cache-service changes, PR read-only and lock-key isolation. |
| docker/setup-buildx-action: **8d2750c68a42…** (#v3) → [**v4.4.1**](https://github.com/docker/setup-buildx-action/releases/tag/v4.4.1) | Builder lifecycle; 1–2d/M shell equivalent, retain | 0.5–1d/M cleanup/disk budget; separately floating BuildKit/Buildx. |
| docker/build-push-action: **10e90e3645ea…** (#v6) → [**v7.4.0**](https://github.com/docker/build-push-action/releases/tag/v7.4.0) | Runtime image/cache; 2–4d/M shell equivalent, retain | 0.5–1d/M load=true/push=false, main-only cache writes/image identity; metadata-log command-injection fix warrants review, not a proven exploit claim. |
| google-github-actions/auth: **7c6bc770dae8…** (#v3) → [**v3**](https://github.com/google-github-actions/auth/releases/tag/v3) | WIF/OIDC credentials; 3–5d/H equivalent, retain, not stored keys | Current release line; exact latest-commit equivalence not established; validate issuer/audience/credential cleanup. |
| google-github-actions/setup-gcloud: **aa5489c8933f…** (#v3) → [**v3.0.1**](https://github.com/google-github-actions/setup-gcloud/releases/tag/v3.0.1) | CLI setup; 0.5–1d/M shell equivalent, retain | Pin matches latest stable commit; separate SDK583 pin remains behind. |

### Other fetched source and assets

| Input: pinned/current → latest | Need / hand effort | Upgrade or replacement constraint |
|---|---|---|
| glideapps/fake-openai **eaa274c562ea7b1ec6dce496a1442cfbb55b4106 → same HEAD**; flingit **0.0.70 → 0.0.70** | `scripts/local-fake-provider.mjs` real local auth/inference/DB fixture; 10–20d/H equivalent, retain | 1–3d/M any revision change: external lock/source, fling version/URL/SHA512 guards, identity/readiness/origins/provenance/cancellation/owned cleanup. Remote lock **outside three local audits** [source](https://github.com/glideapps/fake-openai). |
| Iosevka Etoile **34.9.0 → 34.9.0**; JetBrains Mono **2.304 → 2.304** | `apps/web/public/fonts/manifest.json`: product font subsets/OFL/hash provenance; ≥250d/H equivalent type design | Current [Iosevka](https://github.com/be5invis/Iosevka/releases/tag/v34.9.0)/[JetBrains](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304). Replacement <1d code but design/geometry risk; regenerate renamed licensed subsets/CSS/hash, real loading/shaping/terminal-column tests. |
| DejaVuSansMono.ttf fixture: bundled version **not extracted** → upstream **2.37** | `e2e/fixtures/fonts` fixed historical geometry; ≥250d/H type design | Retain fixed fixture, don't automatically refresh [release](https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37). |

`apps/web/src/components/HarnessIcon.tsx` vendors Claude's asterisk SVG from [Simple Icons](https://simpleicons.org/) under CC0; no source-version pin is recorded, no meaningful package upgrade applies, and the small static SVG is already maintained locally.

Bash/POSIX tools, coreutils, tar/gzip/SHA256, OpenSSH/IAP and Linux namespace/ext4 tools are platform contracts managed by the distro, not individually downloaded app libraries. No pip requirements, Go modules or preinstalled Rust compiler pin were found in these install paths. `octocat/Hello-World` is a live clone validation fixture, not a released dependency. Cloud/vendor availability can fail independently of local locks.

## Security and transitive coverage

The initial root `npm ci` succeeded: 735 installed packages, 743 audited, **zero npm advisory findings**. Independent `npm audit --json` queries also returned zero for the root and both standalone locks. Audit totals vary with workspace accounting, platform-optional packages, and the subsequent typings cleanup; these are observations, not interchangeable package counts.

The pinned baseline lock inventory contains 728 external package records in the root lock, 150 in each standalone lock: **1,028 records across three independent graphs, 678 distinct external names**. The typings removal subtracts one record/name: 727 root, 1,027 combined, 677 distinct. The graphs overlap; optional platform records need not be installed. Live registry metadata was compared for the complete graph, but the audit did **not** manually review every transitive package's implementation, maintenance history, or migration. Direct-dependency review covers all 60 baseline names (59 retained); 42 baseline names (41 retained) have at least one older locked version than registry latest.

| Baseline graph | Records below registry latest | Distinct names below latest |
|---|---:|---:|
| Root/workspaces | 318 | 288 |
| Native-MCP standalone | 65 | 64 |
| Subagent standalone | 68 | 67 |

`npm outdated --all --json` independently returned exit1, **304 names / 564 dependent rows / 306 locations** for the installed root workspace tree. It excludes standalone locks and reports wanted/latest/dependents differently from exact-lock semver comparison; these totals are not additive. Alias install names (string-width-cjs/strip-ansi-cjs/wrap-ansi-cjs) normalize to actual registry names in the graph union. Deprecation evidence: `node-domexception@1.0.0` (prefer native DOMException) and nested `glob@10.5.0` (unsupported/security warning); treat owner updates as the boundary, not arbitrary transitive deletion.

**Undici requires independent security triage.** [7.30.1](https://github.com/nodejs/undici/releases/tag/v7.30.1) and [8.12.2](https://github.com/nodejs/undici/releases/tag/v8.12.2) document TLS-option/renegotiation, redirect/cache, Content-Encoding and other fixes after the locked versions. Some require features not established as used; advisory affected ranges/reachability were not independently proven (advisory API queries failed). Latest Pi1.3 still pins nested8.10.2: a direct7 bump cannot fix it. Node's bundled Undici is a third supply chain, not changed by npm. The actionable triage lives only in `TODO.md`.

Selective transitive scrutiny included Pi's QuickJS/WASI, image/native/optional binaries and worker limits; provider SDK/Bedrock/Smithy fan-out; MCP SSE/OAuth/JOSE/PKCE and OIDC crypto; Google gax/gRPC/protobuf; Fastify router/AJV/serializer/static chains; Markdown/Vega/d3 and bundler graphs. These are used through owning packages. Old nested highlight.js10.7.3 warrants ownership/path awareness, not an age-based vulnerability claim. Native/WASM/platform packages require artifact and process qualification, not import-grep removal.

An empty npm advisory response is not proof of safety: registry advisory ingestion can lag releases, and it does not cover application misuse, local patches, credentials, provider behavior, OS/container packages, downloaded binaries, or all supply-chain compromise. Versions, release security notes, and reachable code paths must be assessed independently.

## Reproduction and qualification

Run from a clean checkout with one exclusive install/check owner per tree; concurrent `npm ci` can delete dependencies while another test copies them ([recorded collision](postmortems/2026-10-16-dependency-audit-validation-collision.md)). The commands below inspect the current workspace:

```sh
npm ci
npm audit --json
npm outdated --all --json # Exit 1 normally means updates exist.
npm view <name> dist-tags time engines peerDependencies --json
npm view <name>@<locked-version> version engines peerDependencies deprecated --json
curl -fsSL 'https://registry.npmjs.org/<URL-encoded-name>'
gh api repos/<owner>/<repo>/releases/latest
```

For a fresh inventory, enumerate `dependencies` and `devDependencies` in the current manifests, exclude private workspace links, and resolve each name from its importing directory through the nearest ancestor `node_modules/<name>` record in the corresponding lockfile's `packages` map. Separately enumerate every lock record to retain nested duplicate versions; do not substitute the manifest's `^` floor or a root-hoisted copy. Preserve query time, dist-tags, publication dates, engines, peers, lockfile hashes, and release URLs: these commands reproduce the method, not a historical registry snapshot.

A proposed update needs a lock diff, clean installs with postinstall patches, typecheck/lint/unit/infra tests, relevant deterministic simulations, and exact-head qualification. Runtime protocol/server/harness changes require `npm run test:e2e` before deployment; frontend changes require Chromium/WebKit/mobile gates; native/image changes require cold builds and actual-process checks. Historical exceptions in `docs/testing.md` do not waive new failures. Preserve the first failure and replay DST traces before changing code. Test-only success does not prove provider authentication, live GCP behavior, or deployment safety.

Retain observable failure boundaries: typed errors, durable lifecycle/history decisions, browser-visible failures, bounded build/boot phase timings and sanitized SDK/provider errors. Compare successful turns, receipt/replication continuity, reconnect/restart, idle/stop behavior, and artifact identity—not merely installation or a green dependency scanner. Existing subsystem contracts and `docs/testing.md` define the release gates; this audit grants no deployment authorization.
