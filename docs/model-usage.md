# Model usage ledger

**Decided 2026-10-12.** Every platform-managed model call writes one content-free row to PostgreSQL `model_calls`: time, owner, orb, use, provider/model, outcome, provider-reported token counts and estimated cost. Rows outlive orb archival and deletion.

## Why

Durable Pi on pi-durable 1.0.0 sent no Codex `prompt_cache_key`; its root calls got 6.3% cached input versus ~95% on host Pi, and nothing noticed (`docs/postmortems/2026-10-12-durable-codex-prompt-cache.md`). Existing usage data cannot answer "what did we spend, where":

- Public history carries usage only for root assistant messages, and orb deletion removes it.
- Pi Durable's `pi.usage` documents cover children and compaction, but are per-conversation totals in private state that archival deletes (`docs/history-replication.md`).
- Luna calls (orb names, activity headlines, turn summaries) record usage nowhere.

## Coverage

All Pi orbs run central Durable (`docs/deployment.md`), so every call is in the control plane:

| `use` | Call site | Capture |
|---|---|---|
| `root` | Durable generation, root conversation | per-orb `ModelRuntime` wrapper |
| `subagent` | Durable generation, child conversation | same wrapper |
| `compaction` | Durable compaction | same wrapper |
| `turn_summary` | `LunaTurnSummarizer` | `completeLuna`'s `onResponse` |
| `headline` | `PiActivityHeadlineGenerator` | `completeLuna`'s `onResponse` |
| `orb_name` | `PiOrbNameGenerator` | `completeLuna`'s `onResponse` |

The wrapper sits beside `fenceModels` around the per-orb `ModelRuntime` from `createDurableModels`. It observes the terminal `AssistantMessage` of `streamSimple` (via the stream's `result()`, without consuming events) and `completeSimple`. Classification relies on pi-durable 1.1.0 internals, guarded by a contract test against the real package:

- Compaction uses `completeSimple`; generation uses `streamSimple` (`fetchDeferred` only with deferred streaming, which pi-orb does not enable).
- Both pass the conversation's persisted `pi.provider` `sessionId`. A generation whose `sessionId` equals the root conversation's is `root`; any other is `subagent`.

**Implemented 2026-10-12.** The wrapper is `meterModels` (`apps/control-plane/src/adapters/durable/model-usage.ts`), applied in `DurableAgent.open` beneath `fenceModels`. The root's `sessionId` is read in the identity commit at open, which materializes `pi.provider` exactly as pi-durable would before its first provider request. The contract test (`apps/control-plane/src/adapters/durable/model-usage.test.ts`) drives real pi-durable through a fake Codex server: a root turn spawning a subagent, then a threshold compaction (`DurableAgent` exposes no manual compact).

`completeLuna` passes every provider response, including failed ones, to an optional `onResponse` callback. The turn summarizer calls `completeLuna` directly rather than through the per-orb `ModelRuntime`, so the wrapper never counts it twice. Every capture point maps the `AssistantMessage` with one function, `modelCall` (`apps/control-plane/src/adapters/model-usage.ts`); the ledger stamps the time inside the insert transaction, after `SET LOCAL`. `at` is recording time, not exact response completion (source audit 2026-10-13). Codemode's `models` global (classifiers, image generation) is disabled, so those calls do not exist.

The full normalized root history separately retains optional `usage.costUsd` from the SDK's `usage.cost.total`, plus `totalTokens`; these are estimates, not subscription charges. The display projection omits usage. History does not replace the retained ledger: it lacks child/compaction/presentation coverage and permanent orb deletion removes it (`apps/orb-runtime/src/domain/mapping.ts`, `docs/history-replication.md`).

Claude orbs are covered separately (below). Not covered: arbitrary model calls made by orb workloads. Calls lost to a crash before their response completes are not recorded; provider-side billing can exceed the ledger.

## Claude orbs

Claude Code calls models inside the VM, in a native process the SDK spawns, so the control plane sees none of them and no OpenTelemetry provider can be injected in-process.

**Implemented 2026-10-13: per-call capture in the runtime.** `main.ts` starts a loopback OTLP/JSON logs receiver (`apps/orb-runtime/src/claude/model-usage.ts`) and the agent spawns Claude Code with `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `http/json`, a 1 s export interval and a random bearer header. Environment set by the spawner outranks project settings, which can only turn telemetry off. Claude Code emits one `api_request` event per model call (model, input, output, cache read/creation tokens, `cost_usd`, `duration_ms`, `ttft_ms`, `request_id`, `query_source`, `effort`, `speed`, plus `agent.name` for subagents) and `api_error` per failed attempt; the receiver keeps only the fields `model_calls` stores (time, model, `query_source`, tokens, cost, duration) and ignores every other event (prompts, responses, tool data) and every non-`claude-code` service, since shell commands inherit the exporter environment. A contract test drives the real binary through the shared native probe (`scripts/claude-sdk-contract/probe.mjs`, whose network guard admits the receiver's port) and requires one exported call per fake API request (`model-usage.contract.test.ts`).

`query_source` classifies the call: `sdk` is the root loop, `agent:builtin:<type>` / `agent:custom` / `agent:default` are subagents, `compact` is compaction, and auxiliary sources include `generate_session_title`, `web_search_tool`, `web_fetch_apply` and `side_question`. In the contract run, the result message's cumulative `modelUsage` omitted the compaction call that telemetry reported.

**Rejected: diffing `result.modelUsage`.** It is cumulative per `query()`, restored on resume, reset by `/clear`, and per model rather than per call or use.

**Implemented 2026-10-14: forwarding through history (question 80 in `docs/open-questions.md`).** The agent appends each call as a hidden `claude.model_call` event whose overflow is the `ClaudeModelCall` (`packages/protocol/src/model-usage.ts`). Replication carries it to the control plane, where `commitHistoryTransaction` inserts the `model_calls` row in the same transaction that stores the record, only when that record is newly inserted, so redelivered batches add nothing. The owner is the orb's project owner. `claudeModelCall` (`apps/control-plane/src/domain/model-usage.ts`) maps the record; one that is malformed stays in history and produces no row.

| `query_source` | `use` |
|---|---|
| `sdk` | `root` |
| `agent:*` | `subagent` |
| `compact` | `compaction` |
| absent | `unknown` |
| any other | the raw value, e.g. `generate_session_title` |

Claude rows have provider `anthropic`, outcome `ok` (`api_request`) or `error` (`api_error`, zero tokens, no cost), and `at` from Claude Code's event timestamp. Each failed attempt is a row.

**Rejected: a runtime→control-plane endpoint.** It needs a new route, client and loss handling; replication already delivers durably, authenticated and exactly once. The cost is history size: the busiest Claude orb on 2026-10-13 had 417 root calls in 2,141 records, so per-call records add at least ~20%.

A receiver that cannot listen leaves Claude running without export and records `claude.model_usage_unavailable` in history. Exports batched in Claude Code at a crash are lost. Record ids are random, so an export the receiver accepted but Claude Code resent would count twice; the loopback makes that unlikely.

## Schema

```sql
CREATE TABLE model_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL,          -- recording time, after the response
  owner_user_id text NOT NULL,      -- whose subscription paid
  orb_id uuid NOT NULL,
  use text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  outcome text NOT NULL,            -- AssistantMessage.stopReason
  input integer NOT NULL,           -- uncached prompt tokens
  output integer NOT NULL,          -- includes reasoning
  cache_read integer NOT NULL,
  cache_write integer NOT NULL,
  duration_ms integer,
  cost_usd double precision,        -- list-price estimate; NULL before 2026-10-14
  response_id text,                 -- Pi AssistantMessage.responseId; NULL for Claude and before 2026-10-24
  ttft_ms integer,                  -- Pi streamed calls: request start → first content event
  thinking_ms integer               -- Pi streamed calls: request start → first answer after reasoning
);
CREATE INDEX model_calls_at ON model_calls (at);
CREATE INDEX model_calls_orb_at ON model_calls (orb_id, at);
```

No foreign keys: archival, orb deletion and project deletion leave rows intact. Rows contain no prompts, responses, tool data or names, so retaining them does not conflict with the deletion contract in `docs/orb-deletion.md`. Pi counts are pi-ai's normalized `Usage`; a failed call records whatever the provider reported, often zeros. `cost_usd` is pi-ai's `usage.cost.total` or Claude Code's `cost_usd`: both are list-price estimates (**decided 2026-10-14**), not subscription charges.

## Timeline timing (decided 2026-10-24)

Purpose: the Pi transcript timeline (`docs/web-ui.md`) joins ledger rows to history and splits each call into waiting, thinking and streaming. Pi only; Claude rows leave all three columns NULL (migration `051_model_call_timing.sql`).

- `response_id` is the `AssistantMessage.responseId` that `modelCall` maps for every Pi capture point, including `completeSimple` and `completeLuna`. It is the same value as the native message's `responseId` in the root history record, so root rows join exactly to history; the contract test asserts this. NULL when the provider reported none.
- `ttft_ms` is the offset of the first **content** event: the first stream event other than `start`, `done` and `error`. With the Codex Responses API that is `thinking_start`, `text_start` or `toolcall_start`, emitted on `response.output_item.added`, i.e. when the model begins its first output item. `start` is not counted: pi-ai emits it when the response headers arrive, before any token.
- `thinking_ms` is the offset of the first `text_*` or `toolcall_*` event, set only when a `thinking_*` event came before it; NULL without streamed reasoning or without an answer. Waiting is `ttft_ms`, thinking `thinking_ms − ttft_ms`, streaming `duration_ms − (thinking_ms ?? ttft_ms)`.

`meterModels` observes events by wrapping the returned stream's `push`, so nothing is consumed or altered. Offsets share `duration_ms`'s origin: pi-ai times a response from the provider stream's creation, after auth, with a monotonic clock. The wrapper reads the agent's clock (`DurableAgent` `now`, else `Date.now`) at each counted event and at the terminal event, and subtracts the distance to the terminal event from `durationMs`; results are clamped so `0 ≤ ttft_ms ≤ thinking_ms ≤ duration_ms` holds by construction. Without `durationMs` (deferred responses) or without content, both stay NULL. `completeSimple` (compaction) and `completeLuna` (summaries, headlines, names) do not stream through the wrapper and record only `response_id`. Rejected: measuring from a clock read before `streamSimple` (it includes auth, so offsets could exceed `duration_ms`) and iterating the stream (it is single-consumer).

## Write path

Claude rows are written inside the history commit (above). For Pi, recording never blocks or fails a model call. The wrapper hands the row to a `ModelUsageLedger` port; the PostgreSQL adapter inserts it asynchronously in its own transaction with `SET LOCAL synchronous_commit = off`, so the commit does not wait for the WAL flush. A database crash can lose roughly the last second of rows; a control-plane crash loses rows not yet inserted.

Volume is a few thousand calls per day, so per-call inserts need no batching. Closing the database drains inserts still in flight, after the central agent plane has closed.

**Rejected: `UNLOGGED` table.** PostgreSQL truncates unlogged tables after any crash or failover, losing the entire history, and excludes them from backups. `synchronous_commit = off` gives the same latency benefit with bounded loss.

**Rejected for now: an external metrics system** (OpenTelemetry to Cloud Monitoring). The question was who would operate it; a table answers the breakdowns with plain SQL and can feed an exporter later. Question 22 in `docs/open-questions.md` remains open for broader observability.

## Observability

Insert failures emit `model_usage.write_failed` (with the store error code) on the first failure after success and `model_usage.write_recovered` on the first success after failure; a healthy ledger logs nothing (`docs/lifecycle.md`). The ledger itself is the observability for model spend and cache health. It does not record full-context versus continuation request shape. The default-transport correction in `docs/pi-adapter.md` establishes request equivalence, not cache-miss causation or billing savings; full-context requests can cache and deltas need not reduce billed tokens.

## Queries

```sql
-- Daily tokens and cache share by use and model
SELECT date_trunc('day', at) AS day, use, model, count(*) AS calls,
       sum(input) AS uncached, sum(cache_read) AS cached, sum(output) AS output,
       round(sum(cache_read)::numeric / nullif(sum(input + cache_read + cache_write), 0), 3) AS cache_share
FROM model_calls WHERE at > now() - interval '7 days'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- Top orbs by uncached input
SELECT orb_id, sum(input) AS uncached, sum(cache_read) AS cached
FROM model_calls WHERE at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

## Usage API and display (implemented locally 2026-10-13)

**Selected:** Trend icon beside Settings → `/usage`; Comparison lines with a left summary rail on wide screens. No schema migration or persisted preference.

**Decided 2026-10-14:** Stack the overview and rankings at ≤900 CSS px to preserve chart room, using a compact summary grid. Phone padding/controls apply at ≤600 px; the range shows dates only. Chromium/WebKit regressions cover breakpoints, chart width and overflow.

`GET /api/v1/usage?boundaries=<JSON timestamp array>` reads the selected user's ledger. Ops uses the existing selected-user header; ordinary users cannot override their owner. Replies are `no-store`. Unknown query fields, non-integer/non-increasing edges, more than 188 edges, intervals over 25 hours or spans over 187 days return 400. Store unavailability returns 503; invalid aggregates return 500, with content-free failure logging.

The browser supplies local-calendar edges as epoch milliseconds. The service validates them; `ModelUsageReader` aggregates bucket/orb/use/provider/model and orb totals in one SQL snapshot, using half-open intervals. The response is `{boundaries, summary, buckets, orbs}`; totals contain `input, output, cacheRead, cacheWrite, calls`. Bucket rows also contain `at, orbId, use, provider, model`; orb rows contain `id, name`. Names join only owner-owned projects. Deleted/missing names are null; their usage remains. The adapter validates bucket/orb rows with the shared response schemas. Unsafe totals fail rather than silently rounding.

| Period | Point/tick |
|---|---|
| Last day | 15 minutes over 24 hours |
| Week | Hour over 168 hours |
| Month | 6 hours since the same local time one calendar month ago |
| 6 months | Local day since the same local time six calendar months ago |

Month subtraction clamps to the destination month's last day. Daily intervals can be 23/25 hours across DST. The final interval ends at request time. Every bucket gets a tick and a zero-filled point. Labels mark local civil boundaries, not rolling bucket edges: every 3 hours (`15:00`) for the last day, midnights (`Oct 08`) for week/month, month starts (`May`) for six months; overlapping ones are dropped at render time (2026-10-14). Month/six-month counts vary with the calendar.

The token-kind timeline labels cache reads **Cached input**, paired with **Uncached input**; cache writes remain separate.

**Decided 2026-10-23:** Usage timeline y-axis labels use compact SI counts (`50M`, `100M`, `1G`) without repeating “tokens”, preserving mobile plot width. A render-only `yAxisFormat` (`.3~s`) opts this timeline in; shared chart defaults and persisted `ChartSpec` stay unchanged. Tooltips retain full comma-separated token counts and units. Existing chart render/error diagnostics suffice; no telemetry or persisted state is added. Chromium/WebKit regressions check compact labels, 320/390px plot widths and left gutters, and exact large-value tooltips.

Summary: token volume, uncached input, output, weighted prompt cache share and recorded calls. Volume sums all four token fields; it is not spend. Cache share is `cacheRead / (input + cacheRead + cacheWrite)`, or `—` without prompt tokens. Failed responses still count as recorded calls. Coverage is Pi, Luna and Claude (from 2026-10-14), not workloads, prices or a completeness guarantee; periods predating capture lack history.

**Decided 2026-10-14:** Breakdowns include Orb alongside token kind, use and provider/model. Orb lines group by retained ledger ID; names come from the existing owner-scoped orb totals, falling back to IDs after deletion. Duplicate names and the reserved Other label include IDs. More than six orbs/models becomes five volume leaders plus Other, preserving totals; ties sort by ID/model. Use/model/orb lines sum all four token fields. No persisted state changes. Qualification and test-only first-failure evidence: `docs/testing.md`. One measure selects all tokens/uncached input/output for both rankings. Rankings show five leading orbs and observed uses; an unnamed use (a Claude auxiliary `query_source`) is labelled with its raw value. Period changes and Retry preserve filters; breakdown/measure changes never refetch. Obsolete reads are aborted/ignored; failures show Retry, not stale totals or an empty-success state.

`Chart.tsx` owns the shared React lifecycle for transcript charts, the usage timeline and Use ranking; `chart-render.ts` and `chart-spec.ts` own rendering, tooltips, isolation and styles. Desktop end labels and the phone key isolate series on hover. Fonts load before Vega measures text. Optional render-only `ChartXAxis {ticks, labels, format}` controls dense ticks and label positions without changing persisted `ChartSpec`.

**Decided 2026-10-14:** Clicking a token-kind end label or phone key selects its matching Measure; clicking an Orb entry follows its encoded ID route. Duplicate/deleted names retain ID identity; aggregate Other has no action. Actionable single-series charts expose their label/key. Hover isolation remains; keyboard Enter/Space selects measures, and orb links retain normal-click, new-tab and keyboard semantics.

**Decided 2026-10-23:** Timeline phone keys stay visually compact, with inline-flex alignment and 4px row gaps. The user rejected the earlier 44px action-key minimum; touch-target size is not a constraint here. Top-orb ranking targets are unchanged. Chromium/WebKit checks cover token-kind and orb control/row geometry at 320/390px and existing activation/hover behavior. Existing diagnostics and visible selection/navigation outcomes suffice; no telemetry or persisted state is added.

Actions stay outside persisted `ChartSpec`: usage returns chart data plus measure/orb-ID targets; the page supplies render-only `seriesActions: ReadonlyMap<string, {href} | {onSelect}>`. The shared renderer knows no usage data or routes. Desktop uses native SVG anchors inside Vega's named text marks (button semantics for callbacks); phones use React anchors/buttons. Mark nodes/layout remain Vega-owned; hover/focus drives existing isolation. Vega's synthetic href handling was rejected because it produces no live native anchors. Selected Measure and standard orb/missing-orb pages expose outcomes; existing render/read diagnostics suffice.

Validation: protocol/service/HTTP/web tests; ledger contracts against PGlite and real PostgreSQL; Chromium/WebKit usage and transcript-chart E2E, including 320/390px, held obsolete reads, retry/empty states and both civil DST transitions. Failure evidence: `test-failures/2026-10-13-token-usage-implementation.md`. No deployment or full release qualification is claimed.

## Top-orb links (approved 2026-10-14; implemented locally)

Top orbs uses one native whole-row anchor for name, proportional bar and exact token count, keyed and routed by encoded ID. Rankings retain full accessible labels, distinguish duplicate names with IDs, use IDs for null names and sort by measure then ID. Gray hover underlines only the name; keyboard focus is visible with one stop per row. Mobile/coarse targets are at least 44px.

A dedicated native component preserves link semantics (Back, new tabs, copy-link) without coupling navigation to shared Vega charts. The timeline and Use ranking retain Vega. Deleted orbs use the existing missing-resource page: requested URL preserved, “Orb doesn't exist” and dashboard link. Existing usage diagnostics and visible errors suffice; no persistence or navigation telemetry added.

[Approved hosted prototype](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/d513d1fd-ee60-4e08-8373-833a56f035f9/design/usage-orb-links/index.html).

Validation: focused units and Chromium/WebKit usage E2E, web typecheck, scoped lint and build. No full release, deployment or physical-device qualification claimed.

## Mock frontend (2026-10-13)

`npm run dev:frontend` serves `/usage` from the mock backend. `apps/web/dev/usage-fixture.ts` generates deterministic quarter-hour events from April 2026, aggregated into requested boundaries, with all six uses, multiple models and five orbs. Four named usage UUIDs are seeded as stopped mock orbs from shared metadata; one nameless UUID deliberately remains missing, exercising retained usage after deletion. Summary, breakdown and ranking totals reconcile; overlapping ranges are additive. No production ledger or provider is contacted.

## Design alternatives (2026-10-13)

Header access keeps analytics separate from the board. Rejected access alternatives: a quick totals-strip meter (too little investigation space), project inspector (limited retained/deleted attribution), replacement usage board (displaces orbs), footer call ledger (less discoverable). Initial [access study](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/df443e84-fa0b-47cd-9e5a-5c786673df3e/studies/token-usage/index.html).

Trend emphasizes consumption over time. Other icon candidates: Bars, Gauge (implies an unrecorded quota), Layers and Sum (less direct analytics signals). Other layouts: Stacked overview (small components flatten), Separate lanes (different scales), Period columns (dense), Time grid (burst detection rather than exact comparison). [Refinement study](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/df443e84-fa0b-47cd-9e5a-5c786673df3e/studies/token-usage-refinements/index.html).

The selected [Comparison lines study](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/df443e84-fa0b-47cd-9e5a-5c786673df3e/studies/token-usage-comparison/index.html) uses the actual chat renderer. Weekly six-month buckets and separate SVG rendering were rejected in favor of daily points and shared interaction/style. Study data is synthetic, not recorded production history.
