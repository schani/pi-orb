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

`completeLuna` passes every provider response, including failed ones, to an optional `onResponse` callback. The turn summarizer calls `completeLuna` directly rather than through the per-orb `ModelRuntime`, so the wrapper never counts it twice. Every capture point maps the `AssistantMessage` with one function, `modelCall` (`apps/control-plane/src/adapters/model-usage.ts`); the ledger stamps the time. Codemode's `models` global (classifiers, image generation) is disabled, so those calls do not exist.

Not covered: Claude orbs (Claude Code calls models inside the VM) and arbitrary model calls made by orb workloads. Calls lost to a crash before their response completes are not recorded; provider-side billing can exceed the ledger.

## Schema

```sql
CREATE TABLE model_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL,          -- response completion
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
