# Model usage ledger

Every platform-managed model call writes one content-free row to PostgreSQL `model_calls`: time, owner, orb, use, provider/model, outcome, provider-reported token counts and estimated cost. Rows outlive orb archival and deletion. The ledger is the observability for model spend and prompt-cache health; it exists because a Durable prompt-cache regression (6.3% cached input) went unnoticed (`docs/postmortems/2026-10-12-durable-codex-prompt-cache.md`). Public history covers only root assistant usage and is deleted with the orb; Durable `pi.usage` documents are private per-conversation totals purged at archive; neither covers Luna.

Not covered: model calls made by orb workloads, and calls lost to a crash before their response completes. Provider billing can exceed the ledger. It does not record full-context versus continuation request shape.

## Pi capture

All Pi calls happen in the control plane.

| `use` | Call site | Capture |
|---|---|---|
| `root` | Durable generation, root conversation | `meterModels` around the per-orb `ModelRuntime` |
| `subagent` | Durable generation, child conversation | same |
| `compaction` | Durable compaction | same |
| `turn_summary` | `LunaTurnSummarizer` | `completeLuna`'s `onResponse` |
| `headline` | `PiActivityHeadlineGenerator` | `completeLuna`'s `onResponse` |
| `orb_name` | `PiOrbNameGenerator` | `completeLuna`'s `onResponse` |

`meterModels` (`apps/control-plane/src/adapters/durable/model-usage.ts`) is applied in `DurableAgent.open` beneath `fenceModels` around the `ModelRuntime` from `createDurableModels`. It observes the terminal `AssistantMessage` of `streamSimple` (through the stream's `result()`, without consuming events) and `completeSimple`. Classification relies on pi-durable internals, guarded by a contract test that drives real pi-durable through a fake Codex server (`model-usage.test.ts`):

- Compaction uses `completeSimple`; generation uses `streamSimple` (`fetchDeferred` only with deferred streaming, which pi-orb does not enable).
- Both pass the conversation's persisted `pi.provider` `sessionId`. Generation with the root's `sessionId` is `root`, any other is `subagent`. The root's `sessionId` is read in the identity commit at open, which materializes `pi.provider` as pi-durable would before its first request.

`completeLuna` passes every response, including failures, to `onResponse`. The turn summarizer calls `completeLuna` directly, not through the per-orb `ModelRuntime`, so nothing is counted twice. Every capture point maps through `modelCall` (`apps/control-plane/src/adapters/model-usage.ts`). Code-mode's `models` global is disabled, so classifier/image-generation calls do not exist.

## Claude capture

Claude Code calls models inside the VM in a process the SDK spawns, so the control plane sees none of them.

- `main.ts` starts a loopback OTLP/JSON logs receiver (`apps/orb-runtime/src/claude/model-usage.ts`). Claude Code is spawned with `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `http/json`, a 1 s export interval and a random bearer header. Spawner environment outranks project settings, which can only turn telemetry off.
- Claude Code emits one `api_request` event per call and one `api_error` per failed attempt. The receiver keeps only the stored fields (time, model, `query_source`, tokens, cost, duration) and ignores every other event (prompts, responses, tool data) and every service other than `claude-code` (shell commands inherit the exporter environment). Contract: `model-usage.contract.test.ts` through `scripts/claude-sdk-contract/probe.mjs`.
- The agent appends each call as a hidden `claude.model_call` history event whose overflow is a `ClaudeModelCall` (`packages/protocol/src/model-usage.ts`). `commitHistoryTransaction` inserts the `model_calls` row in the same transaction that stores the record, only when the record is newly inserted, so redelivered batches add nothing. The owner is the orb's project owner. `claudeModelCall` (`apps/control-plane/src/domain/model-usage.ts`) maps it; a malformed record stays in history and produces no row.

| `query_source` | `use` |
|---|---|
| `sdk` | `root` |
| `agent:*` | `subagent` |
| `compact` | `compaction` |
| absent | `unknown` |
| any other | the raw value, e.g. `generate_session_title` |

Claude rows have provider `anthropic`, outcome `ok` (`api_request`) or `error` (`api_error`: zero tokens, no cost), and `at` from Claude Code's event timestamp. A receiver that cannot listen leaves Claude running without export and records `claude.model_usage_unavailable`. Exports batched inside Claude Code at a crash are lost. Record IDs are random, so a resent accepted export would count twice; the loopback makes that unlikely.

Rejected: diffing `result.modelUsage` (cumulative per `query()`, restored on resume, reset by `/clear`, per model rather than per call; it also omitted compaction). A runtime→control-plane endpoint (new route, client and loss handling; replication already delivers exactly once, at the cost of at least ~20% more Claude history records).

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
  cost_usd double precision         -- list-price estimate; NULL for rows predating cost capture
);
CREATE INDEX model_calls_at ON model_calls (at);
CREATE INDEX model_calls_orb_at ON model_calls (orb_id, at);
```

No foreign keys: archival and orb/project deletion leave rows intact. Rows contain no prompts, responses, tool data or names, so retention does not conflict with `docs/teardown.md`. Pi counts are pi-ai's normalized `Usage`; failed calls record whatever the provider reported, often zeros. `cost_usd` is pi-ai's `usage.cost.total` or Claude Code's `cost_usd`: list-price estimates, not subscription charges. For Pi rows `at` is stamped inside the insert transaction, so it is recording time, not response completion.

## Write path

- Claude rows are written inside the history commit (above).
- Pi recording never blocks or fails a model call. The wrapper hands the row to a `ModelUsageLedger` port; the PostgreSQL adapter inserts it asynchronously in its own transaction with `SET LOCAL synchronous_commit = off`. A database crash can lose about the last second of rows; a control-plane crash loses rows not yet inserted. A few thousand calls per day need no batching. Closing the database drains in-flight inserts after the central agent plane has closed.
- Rejected: an `UNLOGGED` table (truncated after any crash or failover, excluded from backups). An external metrics system (nobody to operate it; SQL answers the breakdowns; question 22 stays open for broader observability).
- Insert failures emit `model_usage.write_failed` (store error code) on the first failure after success and `model_usage.write_recovered` on the first success after failure; a healthy ledger logs nothing.

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

## Usage API

`GET /api/v1/usage?boundaries=<JSON timestamp array>` reads the selected user's ledger; ops uses the existing selected-user header and ordinary users cannot override their owner. Replies are `no-store`. Unknown query fields, non-integer or non-increasing edges, more than 188 edges, intervals over 25 hours or spans over 187 days return 400. Store unavailability returns 503; invalid aggregates 500, with content-free failure logging.

The browser supplies local-calendar edges as epoch milliseconds. `ModelUsageReader` aggregates bucket/orb/use/provider/model rows and orb totals in one SQL snapshot over half-open intervals. Response `{boundaries, summary, buckets, orbs}`; totals hold `input, output, cacheRead, cacheWrite, calls`; bucket rows add `at, orbId, use, provider, model`; orb rows hold `id, name`. Names join only owner-owned projects; deleted orbs have null names and keep their usage. The adapter validates rows with the shared response schemas; unsafe totals fail rather than round.

## Usage page

The dashboard totals strip's Usage link opens `/usage` (look: `docs/design-system.md`). No persisted preference.

| Period | Point/tick |
|---|---|
| Last day | 15 minutes over 24 hours |
| Week | Hour over 168 hours |
| Month | 6 hours since the same local time one calendar month ago |
| 6 months | Local day since the same local time six calendar months ago |

- Month subtraction clamps to the destination month's last day; daily intervals can be 23/25 hours across DST; the final interval ends at request time. Every bucket gets a tick and a zero-filled point. Labels mark local civil boundaries, not bucket edges: every 3 hours (`15:00`) for the last day, midnights (`Oct 08`) for week/month, month starts (`May`) for six months; overlapping labels are dropped at render time.
- **Summary:** token volume (all four token fields; not spend), uncached input, output, weighted prompt cache share (`cacheRead / (input + cacheRead + cacheWrite)`, `—` without prompt tokens) and recorded calls (failures included). Coverage is Pi, Luna and Claude; periods before each source's capture began have no data.
- **Timeline:** token kinds labelled **Cached input** and **Uncached input**; cache writes separate. Y-axis labels use compact SI counts (`50M`, `1G`) through render-only `yAxisFormat` (`.3~s`); tooltips keep full comma-separated counts and units.
- **Breakdowns:** token kind, use, provider/model and orb. Orb lines group by retained ledger ID, with names from owner-scoped orb totals and IDs after deletion; duplicate names and Other include IDs. More than six orbs/models become five volume leaders plus Other, preserving totals; ties sort by ID/model. One measure (all tokens / uncached input / output) drives both rankings. Rankings show five leading orbs and observed uses; an unnamed use (Claude auxiliary `query_source`) shows its raw value.
- Period changes and Retry keep filters; breakdown/measure changes never refetch. Obsolete reads are aborted or ignored; failures show Retry, never stale totals or empty success.
- **Actions.** Clicking a token-kind end label or phone key selects that Measure; clicking an orb entry follows its encoded-ID route. Aggregate Other has no action. Keyboard Enter/Space selects measures; orb links keep normal-click, new-tab and keyboard semantics. Actions stay outside persisted `ChartSpec`: the page supplies render-only `seriesActions: ReadonlyMap<string, {href} | {onSelect}>`. Desktop uses native SVG anchors (buttons for callbacks) inside Vega's named text marks; phones use React anchors/buttons. Rejected: Vega's synthetic href handling (no live native anchors).
- **Top orbs** use one native whole-row anchor per orb, keyed and routed by encoded ID, outside Vega to keep link semantics. Rows sort by measure then ID; one focus stop per row. Deleted orbs land on the standard missing-orb page.
- The timeline and Use ranking use the shared transcript chart renderer (`docs/web-ui.md`); hover shows exact values. Desktop end labels and the phone key isolate series on hover. Fonts load before Vega measures text. Optional render-only `ChartXAxis {ticks, labels, format}` controls dense ticks without changing `ChartSpec`.

`npm run dev:frontend` serves `/usage` from the mock backend: `apps/web/dev/usage-fixture.ts` generates deterministic quarter-hour events from a fixed start date with all six uses, several models and five orbs (one nameless, exercising usage after deletion); totals reconcile across views.
