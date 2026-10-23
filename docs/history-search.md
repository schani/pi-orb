# History search

**Approved decision — 2026-10-22 (America/Los_Angeles); implementation partially qualified, not deployed.** Exact BM25 over committed public history. The user approved the core, one derived table, backfill, structured Pi return shape and exact tool/CLI help copy. Pi registration and help passed local focused checks and real Pi acceptance; exact-head CI remains pending. Existing prompts, including the Claude suffix, stay unchanged. Qualification: `docs/testing.md`; remaining work: `TODO.md`.

## Interface and authorization

Native Pi tool:

```ts
orb_search_history({query, scope?: "orb" | "project" | "user", orbId?, limit?}): Promise<{hits: HistorySearchHit[]} | {error: OrbAgentError}>
```

`OrbAgentError` is `{code: "unauthorized" | "not_found" | "conflict" | "unavailable" | "internal" | "invalid_request", message: string}`. Use native `structuredOutput` and a matching output schema, including errors with `isError`, so code-mode callers receive objects without `JSON.parse`. Framework validation, policy, cancellation and infrastructure failures can still reject. Only the CLI shell boundary serializes JSON.

- Approved tool description: `Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.`
- Approved CLI help: the usage line below plus summary `Search your committed public history with BM25.`

```sh
pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]
```

Default scope is this orb; `orbId` / `--orb` applies only to orb scope. Reject conflicting selectors. Project means the caller's project; user means all that owner's projects. Derive owner, project and current orb from authenticated context. Every scope, including explicit orb IDs, is owner-only: intentionally narrower than company-wide direct transcript inspection (`docs/multi-user.md`). Stopped and archived history remains searchable without waking compute or forcing a pull.

Default limit 10, maximum 50. Each hit contains `orbId`, `sessionId`, `recordId`, `name: string | null` (orb name), `projectName`, `snippet` (at most 500 characters), `score`, `orbUrl`. The URL opens the orb, not a record deep link; use transcript inspection for full context.

The CLI uses incarnation-bearer-authenticated `POST /runtime/v1/history/search`, body `{query,scope?,orbId?,limit?}`, no-store response `{v:1,hits}` (`docs/control-plane-api.md`). Keep queries out of URLs and logs. Both entry points use the shared service through existing layers.

## Searchable text and eligibility

One document is one committed root public `HistoryRecord` with extracted tokens. Follow display eligibility (`docs/web-ui.md`): human/assistant text, displayed custom messages, peer messages, alerts, summaries and public tool text/argument excerpts bounded to 2,000 characters each. Use the same extractor for indexing and snippets.

Exclude system/configuration content, private reasoning, private child transcripts, raw artifacts, images and uncommitted output. Public child notifications remain eligible. Exclude receipt-less native user records whose native string content is exactly a `<local-command-stdout>…</local-command-stdout>` echo; delivered human literals must remain searchable.

Filter statistics and candidates by current transcript eligibility (`docs/history-replication.md`): Pi follows `replication_cursor` ancestry; Claude includes all committed replica records, as default `readHistorySnapshot` does. No persisted visibility flag. Capture authorization, eligibility, statistics and ranking in one statement snapshot. Central Pi sees atomic public projection; Claude may lag committed pull progress.

## Derived index and BM25

One PostgreSQL table, `history_search_documents`: `(orb_id, record_id, token_count, term_frequencies jsonb)`, keyed by `(orb_id, record_id)` with a foreign key to source history. Frequencies map normalized tokens to integer counts. Zero-token rows mark backfill completion but are excluded from the corpus. Store no duplicate text; fetch winning source records and reextract snippets.

One deterministic TypeScript tokenizer serves documents, queries and backfill: Unicode NFKC, lowercase, then words starting with a letter/number and continuing with letters/numbers/combining marks. NUL separates tokens. No stopwords, stemming or fuzzy matching. Only safe tokens enter JSONB; source JSON stays lossless and is never cast to JSONB.

GIN `jsonb_ops` supports OR candidates via `term_frequencies ?| query_terms`; `jsonb_path_ops` does not. Exact scope statistics still scan eligible metadata; common terms may match most documents. No corpus-independent latency guarantee.

For the authorized, transcript-eligible scope, `N` counts all documents and `avgdl` averages their token counts, including nonmatches. `df(t)` counts every document containing term `t`, not a candidate window. Deduplicate query terms; sum matching terms with `k1 = 1.2`, `b = 0.75`, `tf` the stored frequency and `dl = token_count`:

```text
idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
score = Σ idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
```

Rank before limit: descending score, then ascending `(orb_id, record_id)`. Empty token queries/scopes return no hits.

## Commit, retention and enablement

Projection runs in `commitHistoryTransaction`, atomically with source records and cursor changes, including central Pi's enclosing native/public transaction. Retries are idempotent. Index errors use the typed commit-error path and roll back publication. Source deletion cascades; archive retains public history and its index (`docs/orb-deletion.md`, `docs/orb-archival.md`).

Migration `049_history_search.sql` runs idempotent DDL, backfill transactions of at most 500 records using the same extractor/tokenizer, then writes the completion ledger. Existing orb fences and idempotent inserts serialize commits/deletion. Missing rows resume interrupted work; zero-token markers prevent repeated selection. After completion there are no startup scans, repair workers, persisted backfill cursor or compatibility phase.

**First-deployment invariant:** verify every old control-plane history writer quiescent before migration 049, through backfill and new writer activation, including native receipt drain and retirement. Otherwise an old writer can commit unindexed history after backfill passes it; orb fences do not close that gap. `infra/release.sh` migrates before retiring the old version, so ordinary rollout is unsafe. Maintenance-path qualification is tracked in `TODO.md`; no dual-write phase or repair daemon is planned.

## Observability

Record sanitized scope, document/candidate/hit counts, latency and typed failures, never queries/snippets. Failures are caller-visible. Commit diagnostics identify the index stage without private content or healthy-fleet lifecycle noise.

## Rejected approaches

- JSON-string-only Pi results: native structured output avoids redundant parsing.
- PostgreSQL `ts_rank` / `ts_rank_cd`: not BM25.
- In-memory corpus search: transfers/scans the corpus per query.
- Custom extensions, services or caches: unnecessary deployment complexity.
