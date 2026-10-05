# Luna activity headlines

## Requirements (2026-10-04)

**Implemented, pushed and deployed from `d67de4c6d1b4019b229e75f66610df395ef2256f` (2026-10-05, 8:33:32 AM America/Denver), within the qualification bounds below.** Lazy backend headlines for codemode/subagent calls and results, using the existing rail/style. History, rendering and details never wait. Thinking headlines remain separate, without new persistence.

Command-header extension and provider retry qualification (2026-10-05; not deployed): the pre-integration full gate passed against 1,335 source files, hash `d6e72f81ff57e6799a451acd0509e34fd0e8f7460326e93532dbbbd601ef28e6`: typecheck/lint, 2,742 unit/DST tests (12 skips), 122 infrastructure checks, 413 default E2Es in 43 files and zero full/production audit findings. Evidence: `.context/command-headlines/gate/final-summary.json`. This qualifies the feature tree before integration with later main commits, not the combined tree or production. Initial test-first failures remain in `protocol-red.log` (five) and `live-red.log` (three) under `.context/command-headlines/`.

## Selected design (2026-10-04)

### Targets and presentation

- Calls: codemode input intent, canonical SDK `bash` command intent, subagent task intent and `get_subagent_result` retrieval intent (decided 2026-10-05; command extension implemented locally, not deployed). Retrieval source includes only bounded `agent_id` and optional boolean `wait`/`verbose`; arbitrary arguments and private child data are excluded. Results: canonical `bash` public output, `get_subagent_result`, foreground subagent terminal output and typed root completion receipts. Codemode tool results remain ineligible; launch acknowledgements preserve intent. A replicated foreground result replaces intent in the same row, using its own immutable cache key.
- Canonical `steer_subagent` offers intent only for a non-whitespace string `message`, preserving original text within the quoted UTF-8 bound; source includes only `message` and optional string `agent_id`. Malformed IDs are omitted; aliases, arbitrary metadata, native overflow and private child data are excluded. Steering acknowledgements, including delivery errors, offer no outcome and preserve intent (decided 2026-10-05; implemented locally, not deployed).
- Background launch acknowledgements get no outcome generation. Running results describe progress, not completion. Typed updates/workspace notices retain labels; private child transcripts are excluded.
- Single-call categories use the item's headline; multi-call categories retain counts, with individual headers inside. No group summaries.
- Observe the actual header: first seen in a visible tab qualifies, even collapsed; unseen grouped children do not. Pending retains its label; ready changes only the headline. Failure: `Summary unavailable. Retry`, with an independent button. No spinner/badge/help; details never wait.
- Keep state in the existing mounted header under its source identity, not an app-wide overlay or canonical-history mutation. The stable first-source owner survives single→grouped category growth, including ready, error and seen-queued state. Visibility observation retargets the actual child header independently of request lifetime; an unseen child's group header never qualifies it. No new disclosures or global framework. Resolved text survives replay null; rerender/scroll/toggle never repeats requests or clears failure. Navigation return may POST again cheaply from backend cache.
- Unseen hidden-tab work requires a fresh observer callback on show; stale IntersectionObserver callbacks never qualify it. Once qualified, the same source key retains qualification for manual Retry even while hidden/cropped, without a revisibility lease; source/session changes reset qualification. Visibility changes never cancel source work.
- Once seen, queued/active work may finish while cropped, parent-closed but mounted, or tab-hidden. Cancel only on unmount/navigation, session/source change or deadline. Remove unmounted queued work; release slots once. Result selection cancels intent and ignores late completion. Terminal failure requires manual Retry; no visibility leases, polling or automatic client retries.

### Display contract

`headline?: string | null`: null offers unresolved generation; any string (including empty or read/edit paths) displays without generation; absent offers none.

**Decision (2026-10-05; implemented locally, not deployed):** canonical `bash` and codemode call intents also carry `code?: string`, independently of headline eligibility/cache state. Select only string `args.command` for SDK `bash` (`{command:string, timeout?:number}`), or `args.code` for codemode; no aliases, command arrays, arbitrary argument serialization or detail fetch. Omit malformed/whitespace-only inputs. Preserve original whitespace and multiline text, capped at 1,024 UTF-8 bytes including ellipsis without splitting Unicode. The browser Commands category is presentation, not a tool name. Live root `tool_state` and reconnect replay carry the same code before completion and retain it afterward; private child calls publish neither code nor tool state.

Until a summary exists, show this code for absent or null markers, including unseen/no-Luna/pending states. A committed string, including intentional empty string, replaces code; summary failure/Retry overrides code. A result marker's presence still selects the outcome request over intent, while fallback code remains on the matched ancestral call. No outcome code field, group summaries or additional demand. Code is already public input, not a secret scanner: top-level auth fields, native overflow and private child snapshots are excluded; literals inside user code remain public. Generation still uses only immutable replicated sources and the existing bounded quoted source/output and held-request policy.

Use existing enclosing `record.id`, block `detailKey` and transcript orb/session identity. No extra IDs or request object. Shared pure backend projection selects eligible calls/results/root receipts for runtime and HTTP history; frontend has no name/eligibility policy. Runtime emits null when cache is unknown; HTTP history bulk-enriches cached strings without inference. WS stays content-agnostic.

For a paired call/result, generic `headline` field **presence**, including null/empty, selects the result over intent; use the result's record/detailKey. Body, status and headline association follow parent ancestry, not append order, including sibling branches with reused IDs. User/compaction records reset only their descendants; each result consumes the latest unconsumed ancestral call. Absent launch acknowledgement preserves intent. `get_subagent_result` offers retrieval intent and eligible result generation.

Examples within enclosing records:

```json
{"type":"tool_call","callId":"a","name":"read","headline":"src/app.ts","detailKey":"r1:0"}
{"type":"tool_call","callId":"b","name":"codemode","code":"await tools.read({path:'package.json'})","headline":null,"detailKey":"r2:0"}
{"type":"tool_call","callId":"b","name":"codemode","code":"await tools.read({path:'package.json'})","headline":"Inspect project configuration","detailKey":"r2:0"}
{"type":"tool_result","callId":"c","headline":null,"detailKey":"r4:0"}
{"headline":null,"detailKey":"r5:subagent"}
```

The fourth selects result source `r4:0` over call `c`; the fifth is a root receipt. POST only for null. Fixed **two concurrent requests per browser view** leaves connections for details/controls; no durable queue.

**Decision (2026-10-04):** retain this three-way field; extra request objects/source references repeat existing identity without information.

### Request-owned inference

`POST /api/v1/orbs/:orbId/headlines/:recordId/:detailKey?sessionId=...` supplies identity only, with no request body. Successful HTTP responses contain only `{headline: string}`; generation timestamps remain internal cache/service metadata. The presentation service validates replicated source eligibility, never browser tool names/prompts. Typed outcomes: cached/generated headline, ineligible, missing/session mismatch, unavailable (source/inference/persistence); no raw provider errors.

Each POST owns cancellation and one **30-second monotonic deadline** for source wait and Luna. On cache miss, hold it open; reread only the missing record every **1 second** via existing simulation clock/`sleepResult`. Never reset the budget; check it before every new read/inference/write, even if the abort timer fires late. Cloud Run request CPU remains available; no detached work/coordinator.

The original expiry is passed as required internal headline-generator context `deadlineAt`. After owner-credential lookup, the generator checks the monotonic budget before fresh Luna IO, even if the abort callback is late. This is headline-only context: no wire field or global `OperationContext` change.

**Decision (2026-10-05; implemented locally, not deployed):** retry only a known provider HTTP 503 from the SDK's terminal structured `codex_failure` diagnostic on an error completion. Three total generator invocations, with 1-second then 2-second backoff, share the original 30-second monotonic budget with source wait, credentials, inference and publication. The domain owns policy through the existing generator port and simulation clock/`sleepResult`; each invocation passes the original signal/monotonic expiry into the broker, which gates fresh pointer/secret reads, lease acquisition and remote refresh admission after awaited IO; the adapter rechecks before inference. Repeated owner-credential reads preserve this boundary without a prepared-auth state machine; `attempts` counts generator invocations, not guaranteed provider calls. The adapter distinguishes auth/inference/cancellation. SDK `maxRetries: 0` is public and explicit. Shared auxiliary Luna calls also force SSE: the SDK's automatic WebSocket continuation/connection-limit retries are independent of that setting. SSE plus zero retries permits one provider request per admitted Luna invocation; names and runtime summaries use the same fixed auxiliary transport policy. No token-budget/model tuning.

Use the last structured Codex failure only: earlier transport fallback failures and raw message text cannot establish terminal status. Validate integer HTTP status 100–599, allowlisted transport/phase/error code and nonnegative integer token counts at the SDK boundary. Unknown/rejected/empty/auth/aborted completions, HTTP 404/429 and all non-503 failures stop immediately; application 503 from source/cache/persistence is not provider 503. Keep string successes and safe typed failure diagnostics; no raw error content crosses the headline port. Reject message regexes, automatic client retries, detached work and new authentication preparation machinery.

Cancellation/expiry aborts sleep/inference and stops new IO. Already-issued credential lookups may settle, but cannot admit subsequent secret reads or refreshes after cancellation/expiry. **Rotation-safety exception:** a remote OAuth refresh admitted while the caller was live may already have consumed the only usable refresh token. Its existing broker-bounded secret write, fenced publication, invalidation and exact-version cleanup must settle independently of caller cancellation; an acquired lease may also be released. Never return a grant or start inference for that stopped caller. This does not extend the headline expiry or admit another refresh. A successful stopped-caller rotation emits `credential.rotation_settled`, with provider/generation/outcome only (`docs/credentials.md`). Already-issued headline writes may commit later under atomic fences. Neither permits fresh provider IO after expiry; canceled headers publish nothing. Prewrite cancellation leaves no durable pending state.

**Selected simplification (2026-10-04):** concurrent independent POSTs, even in one process, may both infer. First-success conditional insertion stores one value; successful callers return that winner and timestamp, not their losing candidate. For one person and short headlines, occasional duplicate inference beats shared ownership bookkeeping. Reject singleflight/refcounts/shared deadlines/replacement cleanup, durable jobs and distributed locks.

### Source, cache and observability

Use only complete immutable replicated normalized calls/results/root receipts, never partial tokens or runtime detail fallback. Result eligibility follows parent ancestry, not append order: runtime SDK `getEntries()` includes all branches, and reused call IDs otherwise misattribute sibling results. Metadata-only ancestry deltas use O(records) storage and O(depth) lookup, retaining no raw source or private child data.

The backend store's optional internal `readHistorySnapshot` parameter `atRecordId` anchors source context to the requested replicated record. The service takes one anchored snapshot only after the target is present, not on each missing-record 1-second poll. This is ancestor context, not an all-record replica read. Ordinary HTTP history cursor/head/records remain unchanged: the default control-plane snapshot follows `replication_cursor` ancestors, not `headId`. An earlier inactive normalized branch target can still generate without waking compute.

**Decision (2026-10-04):** use causal source projection. Reject a linear pending-map copy from the UI: a valid imported SDK branch fixture proves sibling misattribution with reused IDs. This experimental fixture showed no actual secret transmission and is not an incident requiring a postmortem.

Authorize before cache/source access. Stopped/archived requests use replica/cache, never wake compute. Conditional insertion atomically checks orb/project, current session and source existence: deletion cannot resurrect metadata or stale sessions publish it.

Presentation service calls immediate store/inference ports; adapters own SQL/provider access. Reuse `@pi-orb/luna` fixed model, no-tools/minimal reasoning and project-owner credential binding, never viewer credentials.

Bound relevant argument/outcome text; exclude known auth fields, overflow, reasoning, images and private child transcripts. Owner-owned code/prompts/results may still contain secrets; no generic secret scanner. Quote source as untrusted data. Request one plain line, roughly 8–12 words, enforcing existing 1 KiB cap. Preserve error/progress facts; headlines never change authoritative status.

Migration `030_activity_headlines.sql` adds one table: unique `(orb_id, session_id, record_id, detail_key)`, headline, generation timestamp. Intent/outcome derives from source. No model/prompt revision keys. Cascade orb/session/history deletion; archives retain cache. History/cursor stay immutable.

Existing durable lifecycle/event boundary records one content-free terminal outcome per headline POST except successful cache hits, which alone are silent. Every terminal typed failure, including cache-read failure, emits one event: identity, typed source/inference/persistence outcome, model, elapsed time, stored-winner metadata and correlation. Each autonomous 503 retry emits `headline.retry_scheduled` with failed attempt, nominal delay, status/reason, identity, model and elapsed time. `headline.completed` adds generator-attempt count, termination (`succeeded`, `retry_exhausted`, `not_retriable`, `cancelled`, `deadline_exceeded`), failure stage and validated provider status/transport/phase/stop reason/error code/token counts when known. Successful recovery retains the last failure's diagnostic context. At most two retry edges and exactly one terminal event; successful cache hits stay silent. Existing lifecycle logging is the durable query boundary. Never raw prompts/headlines/provider errors. History bulk-cache enrichment is best-effort: read failure leaves null markers, without per-read lifecycle level events or logging state machinery. The user POST's scoped error remains observable; rereads/renders add no noise. Process-alive cancellation is observable; abrupt process death cannot guarantee a terminal event. Stored successes remain queryable. Failed persistence returns unavailable, never false cached success; header failure/Retry is independent of orb lifecycle.

**Rejected alternatives:** history-read generation blocks browsing/pays for unseen content; WS interception breaks proxy boundaries; frontend allowlists duplicate source policy; groups add another summary level; revision keys add needless invalidation. Refresh-gated readiness strands live rows because open WS rejects refresh and replica polling is about 10 seconds; bounded rereads inside the same POST avoid extra client state. Detached jobs lose request CPU/ownership; durable leases/retries solve no requirement.

## Qualification contract (2026-10-04)

### Backend DST: two groups

Use existing `runDst`/`makeHarness` with the service, atomic fake store and controlled `ResultAsync` inference; each POST is an independent task. No real provider/host/HTTP.

1. **Request lifetime, source and fences.** Replicate after a gated missing-source read: the same held POST completes. Cancellation/monotonic expiry stops new reads/inference/writes even with delayed abort callbacks. Gate deletion/session change around generation/write: no stale publication/resurrection. Already-issued writes may finish only under valid fences; late inference cannot start a write.
2. **Concurrent cache publication.** Two same-key requests both infer different candidates. Gate insertion for either winner: one stored value, identical returned text/timestamp, unchanged transcript/cursor.

Gate prerequisites (read observed, inference started, write issued) before mutations; fake guard-and-insert is indivisible. Use virtual monotonic 30-second/1-second timing and existing late-timer coverage, not sleep-based ordering. Already-issued writes/responses may settle after expiry. `withDeadline` signals cancellation, not a hard race; test adapter signal handling/typed cancellation. Preserve traces; replay `DST_REPLAY` before fixes. No singleflight/replacement/restart matrix or new clock framework.

### Provider retry qualification (2026-10-05)

Tests precede implementation; RED and replay evidence live in `.context/headline-retry/`. SDK fixtures prove structured terminal status, earlier/non-Codex/message-only 503 rejection, empty output and rejected completions. Adapter tests prove safe facts survive without raw provider messages and credential-expiry checks remain intact. Service tests exclude auth/unknown/empty/rejected/404/429/502 retries. Nominal DST campaigns explicitly disable late timers to reach backoff: 503→success publishes once without history mutation; 503×3 never caches; cancellation/monotonic expiry during backoff admits no fresh IO; source wait and backoff share the original expiry. Default late-timer safety retains 100 iterations, plus issued-model/write and independent-winner fences. Retry telemetry asserts bounded edges, one terminal outcome and no source/headline content. Retained replay failures exposed fractional timestamp subtraction and a verification-read checkpoint after expiry; assertions now distinguish configured delay from floating-point precision and expiry from settlement.

Independent review found two admission gaps: whole-broker mocks hid post-await credential IO, and SDK zero retries did not disable automatic WebSocket retries. Tests preceded both fixes. Real-broker DST gates pointer/secret/lease/issued-rotation settlement for cancellation and monotonic expiry; real adapter/broker tests exclude downstream secret/provider IO after a held pointer lookup. A pinned actual-SDK test forces SSE and returns synthetic HTTP 503, asserting exactly one fetch and terminal SSE diagnostics without paid/provider network traffic. Rotation settlement retains existing CAS/cleanup fences.

The full pre-integration gate above includes these changes; neither focused nor full mock-based qualification establishes deployment or real-provider acceptance.

### Shared store contract

Extend `apps/control-plane/src/testkit/store-contract.ts` once for memory/PGLite/PostgreSQL: uniqueness/key isolation, atomic orb/project/session/source fences, cascades/archive retention, no history/cursor mutation. SQL insertion/deletion/session races prove atomicity, not service lookup order. No lifecycle matrix.

### Ordinary units/routes

- Null/string/empty/absent and generic result-presence/acknowledgement semantics; no frontend eligibility or extra identity.
- Auth before cache/source; owner not viewer credentials. Cached history: zero Luna; stopped/archive: zero host.
- HTTP integration with open WS: source arrives after held POST, same request completes with no history GET or second POST.
- Bounded immutable input/output, typed failures/cancellation, persistence failure without false cache claim. Reuse existing `capHeadline`/Luna primitive tests.
- Failed/canceled request then fresh manual retry: ordinary service test, no recovery framework.
- Capture content-free terminal POST outcomes with diagnostic fields above, including cache-read failures; only successful cache hits are silent. History enrichment failures leave null without per-read lifecycle events. No raw logs, reread noise or logging state. Cancellation observable only while alive.

### Browser: four focused cases

Existing Chromium/WebKit suites, gated transport/clock; no sleeps/timeout increases. Drain held routes on teardown.

1. **First seen.** Only generic null requests, including collapsed headers and artificial names; strings/empty/absent do not. Hidden grouped children never start unseen work. Once started, scroll-away, parent closure while mounted and tab hiding allow completion without another POST.
2. **Two-request limit.** Hold two POSTs; details and controls remain usable. Another seen header queues, maximum two active; unmounting queued work prevents launch. Previously seen queued work may launch while cropped.
3. **Scope, replay and result change.** Replay null does not repeat while mounted. Outcome selection cancels intent; late intent cannot overwrite it. Navigation/new session ignores stale responses, even when identities are reused.
4. **Failure and Retry.** Failure survives scroll/disclosure toggles; only the independent Retry button retries, without toggling or blocking details.

Narrow request-limit helper tests use controlled responses for slots/scope. Browser coverage uses deterministic gates, not a controller framework or another DST matrix.

### Test-first implementation

Projection/source and shared-store contracts preceded boundaries/cache migration; backend DST and ordinary service/adapter/route tests preceded service/HTTP wiring. Helper/header tests preceded UI wiring. Browser fixture RED came after concurrent UI work was already written, before fixture implementation: all eight cases failed at the missing opt-in seed endpoint (404), not missing product UI. Source-lifecycle regressions were red before their causal fixes. Full `npm run test:e2e` remains the deployment gate for runtime protocol/server/harness changes.

### Current qualification (2026-10-05)

[Deploy 37316402844](https://github.com/schani/pi-orb/actions/runs/37316402844) validated exact source `d67de4c6d1b4019b229e75f66610df395ef2256f`: all twelve gates, 2,691 unit/DST tests (twelve skips) and 407 Docker/PostgreSQL/Chromium/WebKit E2Es in 42 files (zero skips). This includes lazy activity headlines and the prior `af06b87` thinking Markdown/inline-heading rendering. Serving, authority, IAP, cleanup and bounded log evidence: `docs/deployment.md`. Dedicated production real-caption, role/cache and provider business-success acceptance was not run; scripted E2E coverage uses the mock. The earlier user-confirmed real-Luna smoke below remains separate evidence. Running guests retain their old runtime until ordinary Stop/Start; no forced fleet restart occurred. Historical local counts below are unchanged.

Earlier fresh isolated validation matched all 1,329 final executable source files, including the volume-adoption guard: `.context/loose-ends/gate-final-source-inventory.json` and `gate-final-summary.json`. The complete gate covers visibility/Retry, causal backend/UI pairing, empty thinking, SQL publication fences, patch-runner and fixture isolation. Earlier evidence below retains its original scope.

- **Earlier root proof:** typecheck/lint passed; `npm test` passed 340 files / 2,661 tests, with 12 tests skipped; infra Node 36, Python 52 and native VM 24 passed. Default late-timer safety passed 100 iterations plus budget-proxy/no-Luna tests; the elapsed-deadline trace was replayed, retaining expiry safety rather than requiring success after expiry. Source: `.context/headline-implementation/root-summary.md` and retained service replay logs.
- **Full Docker gate after causal fixture fix:** 42 files / 367 tests passed, zero skips, including 79 real PostgreSQL tests, all four headline publication fences, 8 headline frontend and 16 lifecycle cases across Chromium/WebKit. The original two failures exposed missing causal fixture ancestry, not a timeout problem; original failure evidence remains preserved. Source: `.context/headline-implementation/root-e2e-postfix.summary.md`, `root-summary.md` and `root-e2e.log`.
- **Final visibility/Retry patch:** six deterministic hidden-first-seen/stale-observer and same-source Retry failures were recorded before the causal fix, without timeout weakening. Focused qualification passed 36 tests (8 main + 28 lifecycle, both engines). Source: `.context/headline-implementation/ui-hidden-red.log` and `ui-hidden-focused.log`.
- **Earlier feature-tree frontend/static proof:** root typecheck/lint/diff checks and web units (75 files / 500 tests) passed. An involuntary host restart interrupted the broader process-backend frontend command, not a test failure: its preserved log completed 2 files / 158 tests (session 86, mobile 72); the resume passed the remaining 28 files / 92 tests. Aggregate: 30 files / 250 tests, not one uninterrupted command. The separate 28 lifecycle tests remain additional proof; the focused main 8 are already in the aggregate. Source: `.context/headline-implementation/resume-final-summary.md`, `resume-final-frontend.{command,log,exit}` and preserved `ui-hidden-all-frontend.log`.

**Final guard-qualified proof:** clean `npm ci`, ten Node patch-runner tests, typecheck/lint (no errors; existing warnings), 2,690 unit/DST tests in 340 files (twelve existing skips), 122 infrastructure checks (46 Node + 52 Python + 24 native VM), 385 default Docker/PostgreSQL/Chromium/WebKit E2Es in 42 files (zero skips), and zero audit findings pass. Post-create volume inspection rejects wrong orb-ID or scope before mounting. Final executable-source hash: `6a35bd7facec7f085fa0035fba0e02379b3cd7f3a524e95fa08df2c00af1689c`; no content, mode or path mismatches. Evidence and preservation bounds: `docs/testing.md`, `.context/loose-ends/gate-final-summary.json`. Host-key fixture cost and the active installation vulnerability chain are also qualified; historical standalone artifacts are unchanged.

The user already reported the real-Luna smoke “works!”. This is user-supplied live acceptance, not automated transport-test evidence; it was not rerun. Ports 7100/5173 stayed alive and unchanged: final-source qualification does not prove cached backend modules in that preview adopted later fixes without restart.

The earlier Docker build-cache failure and interrupted foreign-inventory sweep remain separate failed attempts, not green retries (`docs/postmortems/2026-10-05-e2e-docker-inventory-isolation.md`). The historical WebKit pointer-interception cause remains unproved (`docs/postmortems/2026-10-04-webkit-read-drawer-hit-test.md`). The corrected bounded stopped-orb fixture passed adversarial and frontend qualification; the user waived deep historical forensics under the 2026-10-05 UI exception recorded in `AGENTS.md` and `docs/testing.md`, not the requirement to correct and validate new failures. The subsequent production gate above passed. Retained evidence lives in ignored `.context/headline-implementation/` and `.context/loose-ends/`; browser sources live in `e2e/`.

## Visual study

[`design-prototypes/luna-header-summaries.html`](../design-prototypes/luna-header-summaries.html) remains a visual reference for rail/fonts, collapsed generation, disclosures and Retry; it simulates inference, not backend ownership. Its prior testing outline is not normative: the implemented contract and qualification status are here. Earlier artifacts remain in ignored `.context/luna-headlines/`; no HTML/smoke changes or rerun.
