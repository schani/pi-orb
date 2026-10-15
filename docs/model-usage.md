# Model usage ledger

**Decided 2026-10-12.** Every platform-managed model call writes one content-free row to PostgreSQL `model_calls`: time, owner, orb, use, provider/model, outcome and provider-reported token counts. Rows outlive orb archival and deletion.

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

The full normalized root history separately retains optional `usage.costUsd` from the SDK's `usage.cost.total`, plus `totalTokens`; these are estimates, not subscription charges. The display projection omits usage. History does not replace the retained ledger: it lacks child/compaction/presentation coverage and permanent orb deletion removes it (`apps/orb-runtime/src/pi/mapping.ts`, `docs/history-replication.md`).

Not covered: Claude orbs (Claude Code calls models inside the VM) and arbitrary model calls made by orb workloads. Calls lost to a crash before their response completes are not recorded; provider-side billing can exceed the ledger.

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
  duration_ms integer
);
CREATE INDEX model_calls_at ON model_calls (at);
CREATE INDEX model_calls_orb_at ON model_calls (orb_id, at);
```

No foreign keys: archival, orb deletion and project deletion leave rows intact. Rows contain no prompts, responses, tool data or names, so retaining them does not conflict with the deletion contract in `docs/orb-deletion.md`. Counts are pi-ai's normalized `Usage`; a failed call records whatever the provider reported, often zeros.

## Write path

Recording never blocks or fails a model call. The wrapper hands the row to a `ModelUsageLedger` port; the PostgreSQL adapter inserts it asynchronously in its own transaction with `SET LOCAL synchronous_commit = off`, so the commit does not wait for the WAL flush. A database crash can lose roughly the last second of rows; a control-plane crash loses rows not yet inserted.

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

Summary: token volume, uncached input, output, weighted prompt cache share and recorded calls. Volume sums all four token fields; it is not spend. Cache share is `cacheRead / (input + cacheRead + cacheWrite)`, or `—` without prompt tokens. Failed responses still count as recorded calls. Coverage is Pi + Luna, not Claude/workloads, prices or a completeness guarantee; periods predating capture lack history.

**Decided 2026-10-14:** Breakdowns include Orb alongside token kind, use and provider/model. Orb lines group by retained ledger ID; names come from the existing owner-scoped orb totals, falling back to IDs after deletion. Duplicate names and the reserved Other label include IDs. More than six orbs/models becomes five volume leaders plus Other, preserving totals; ties sort by ID/model. Use/model/orb lines sum all four token fields. No persisted state changes. Qualification and test-only first-failure evidence: `docs/testing.md`. One measure selects all tokens/uncached input/output for both rankings. Rankings show five leading orbs and observed uses. Period changes and Retry preserve filters; breakdown/measure changes never refetch. Obsolete reads are aborted/ignored; failures show Retry, not stale totals or an empty-success state.

`Chart.tsx` owns the shared React lifecycle for transcript charts, the usage timeline and Use ranking; `chart-render.ts` and `chart-spec.ts` own rendering, tooltips, isolation and styles. Desktop end labels and the phone key isolate series on hover. Fonts load before Vega measures text. Optional render-only `ChartXAxis {ticks, labels, format}` controls dense ticks and label positions without changing persisted `ChartSpec`.

**Decided 2026-10-14:** Clicking a token-kind end label or phone key selects its matching Measure; clicking an Orb entry follows its encoded ID route. Duplicate/deleted names retain ID identity; aggregate Other has no action. Actionable single-series charts expose their label/key. Hover isolation remains; keyboard Enter/Space selects measures, and orb links retain normal-click, new-tab and keyboard semantics. Phone action keys are ≥44px tall.

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
