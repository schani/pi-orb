# History search

**Approved decision — 2026-10-22 (America/Los_Angeles); core ready locally, full qualification pending, not deployed.** True BM25 search over public history, designed for a Pi tool and `pi-orb` for Claude. The user approved the core, derived persisted table and one-time backfill below. Pi tool registration and CLI help remain pending the user's wording approval; no further prompt approval is claimed. The existing Claude suffix stays unchanged.

Sources: [docs/history-replication.md](history-replication.md) (records, commit boundaries, snapshot eligibility), [docs/pi-adapter.md](pi-adapter.md) (central Pi), [docs/claude-agent-sdk.md](claude-agent-sdk.md) (native replication), [docs/control-plane-api.md](control-plane-api.md) and [docs/multi-user.md](multi-user.md) (authorization), [docs/web-ui.md](web-ui.md) (display eligibility).

## Interface and authorization

Pi return shape approved; registration and exact prose remain pending user approval:

```ts
orb_search_history({query, scope?: "orb" | "project" | "user", orbId?, limit?}): Promise<{hits: HistorySearchHit[]} | {error: OrbAgentError}>
```

`OrbAgentError` is `{code: "unauthorized" | "not_found" | "conflict" | "unavailable" | "internal" | "invalid_request", message: string}`. Return the outcome through native `structuredOutput` with a matching output schema, so code-mode callers receive the object without `JSON.parse`, including when `isError` is true. Validation, policy, cancellation and infrastructure failures can still reject. No framework changes are needed. `--json` serializes only at the CLI shell boundary.

- Pending tool description: `Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.`
- Pending CLI help: only the existing usage line below plus summary `Search your committed public history with BM25.` No other new help prose, examples or retry text is proposed.
- These proposals replace the earlier verbose help proposal, not existing runtime help. Registration and new prose are not applied; system/Claude/namespace/other tool descriptions stay unchanged.

```sh
pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]
```

- Default: this orb. `orbId` / `--orb` applies only to orb scope; reject conflicting scope selectors.
- Project means the caller's current project; user means all the authenticated owner's orbs across projects. Derive current orb, project and owner from authenticated context, not caller-supplied ownership fields.
- Every scope is owner-only, including explicit orb IDs: intentionally narrower than company-wide direct transcript inspection. Archived and stopped history remains searchable without waking compute.
- Default limit 10, maximum 50. The shared service returns `{hits}`. Each hit contains `orbId`, `sessionId`, `recordId`, `name: string | null`, `projectName`, `snippet`, `score`, `orbUrl`; `name` is the orb name. Snippets are at most 500 characters.
- The CLI uses incarnation-bearer-authenticated `POST /runtime/v1/history/search` with JSON body `{query,scope?,orbId?,limit?}` and no-store response `{v:1,hits}`. Keep queries in the body, never URL query strings or logs.
- Use existing transcript inspection for full context; `orbUrl` opens the orb, not a promised record deep link. Pi and CLI share the same search service through existing layered boundaries.

## Searchable text and eligibility

One searchable document is one committed root public `HistoryRecord` with nonempty extracted tokens. Follow display eligibility, not an indiscriminate JSON crawl: visible human/assistant text, displayed custom messages, peer messages, alerts, summaries, and public tool text/argument excerpts bounded to 2,000 characters each.

Exclude hidden system/configuration content, private reasoning, private child transcripts, raw artifacts, images and uncommitted output. Public child-notification text is eligible; private child history is not. Conservatively exclude receipt-less native user records whose native string content is exactly a `<local-command-stdout>…</local-command-stdout>` command echo. Do not filter human-authored literals by text alone; delivered human messages remain searchable. Reuse the same extractor for indexing and winning snippets.

Index stored root public records, but filter both statistics and candidates at query time using current transcript eligibility: Pi follows `replication_cursor` ancestry; Claude includes all committed replica records, as default `readHistorySnapshot` does. No persisted visibility flag. Capture scope, eligibility, statistics and ranking from one consistent database snapshot.

Central Pi search sees atomic public projection; Claude sees normal committed pull progress and may lag. Search never forces a pull or wakes an orb.

## Derived index and BM25

One PostgreSQL table, `history_search_documents`: `(orb_id, record_id, token_count, term_frequencies jsonb)`, keyed by `(orb_id, record_id)` and referencing the original history row. `term_frequencies` maps safe normalized tokens to integer counts. Records with no tokens get `token_count = 0` and empty frequencies as backfill completion markers, excluded from search statistics and candidates. Store no duplicate text; fetch winning original `HistoryRecord`s and reextract snippets after ranking.

Use one deterministic TypeScript tokenizer for documents, queries and backfill: Unicode NFKC normalization, lowercase, then words starting with a letter or number and continuing with letters, numbers or combining marks. NUL is a separator. No stopwords, stemming or fuzzy matching. Only safe tokens enter JSONB. Preserve lossless source JSON; never cast history payloads to JSONB.

A GIN index using `jsonb_ops` supports `term_frequencies ?| query_terms` for OR candidates; `jsonb_path_ops` does not support this operator. No extensions, external services, caches or workers.

For authorized, transcript-eligible documents in the selected scope:

- `N` is the document count; `avgdl` is their mean `token_count`, including nonmatching documents.
- `df(t)` counts **all** eligible documents containing term `t`, not a limited candidate window.
- Deduplicate query terms. For each candidate, sum the following over matching terms, with `k1 = 1.2`, `b = 0.75`, `tf` the stored count and `dl = token_count`:

```text
idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
score = Σ idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
```

Rank all matching eligible candidates **before** applying the limit: descending score, then ascending `(orb_id, record_id)` for deterministic ties. Empty token queries or empty scopes return no hits. Positive IDF and actual term frequency/length normalization make this BM25, not native text-search rank.

GIN narrows candidates; exact scope statistics still require scanning eligible index metadata, and common terms may match most documents. No corpus-independent latency guarantee or full-corpus transfer into application memory.

## Commit, retention and enablement

Projection runs at shared `commitHistoryTransaction`, in the same transaction as source records and cursor changes, preserving central Pi's enclosing native/public atomicity. Duplicate commits/retries are idempotent. Index failures follow the existing typed history-commit error path and roll back publication, without new per-record event spam.

Deletion cascades from source history; archive retains the index with public history under `docs/orb-deletion.md` and `docs/orb-archival.md`. Authorization follows `docs/multi-user.md`, with owner-only search in every scope.

Migration `049_history_search.sql` uses a custom once-only sequence: idempotent DDL, bounded application backfill batches of at most 500 records using the identical extractor/tokenizer, then the `schema_migrations` completion marker. Existing orb fences and idempotent inserts protect concurrent commits, retries and deletion. Zero-token marker rows prevent empty/hidden records from being selected repeatedly. A failed attempt resumes through missing index rows; after completion there are no startup scans, repair daemons, persisted backfill cursor or compatibility phase.

**First-deployment invariant:** all old control-plane history writers must be verified quiescent before migration 049 starts, and remain quiescent through backfill until the new writer code is active. This includes native receipt drain and old-writer retirement: an old writer can commit unindexed history after backfill has passed it. Orb fences alone do not prevent that gap. `infra/release.sh` currently migrates before retiring the old version, so the ordinary rollout does **not** satisfy this invariant. No compatibility/dual-write phase or repair daemon is planned. The deployment gate and maintenance-path qualification are tracked in `TODO.md`; no safe deployment is claimed.

## Qualification and observability

Final focused core validation passes 320 tests in 15 files, including text/snippets (27), 100 deterministic schedules, protocol/CLI, runtime/issuer routes, PGlite and transaction/migration contracts. Separate PGlite qualification passes 12 tests; real PostgreSQL 16.15 passes 14, including five explicitly synchronized transaction/snapshot/backfill/archive/delete concurrency cases and the actual GIN query plan. The combined run did not use real PostgreSQL. Evidence and limits are in `docs/testing.md`.

Global typecheck and lint pass (baseline lint warnings remain). Full validation remains pending. The root `npm test` attempt was cancelled by the parent tool's 300-second deadline after 56 files, with no assertion failures found; it has no completed result. Evidence is preserved in `/tmp/history-search-full-unit.log`. E2E source is ready but has not run: Pi registration awaits wording approval. These focused results do not establish full qualification or deployment safety.

Existing telemetry records sanitized scope, eligible-document/candidate/hit counts, latency and typed failure categories, never query or snippet text. Typed failures are visible to callers. Existing history-commit diagnostics must identify the index stage without private content; no new healthy-fleet lifecycle noise.

## Rejected approaches

- JSON-string-only Pi wrapper (`Promise<string>`): forces programmatic callers to parse an already structured result; native `structuredOutput` preserves `{hits}` directly.
- PostgreSQL `ts_rank` / `ts_rank_cd`: not BM25.
- In-memory full-corpus search: transfers and scans the entire corpus per search.
- Custom BM25 extensions or external search services: unsupported deployment complexity for this scope.
