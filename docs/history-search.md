# History search

## Decision — 2026-10-29 (PDT)

Search committed public history with `pg_textsearch` BM25 and one expression index on `history_search_public_text(history_records.record)`, using the English text configuration. PostgreSQL maintains it for every writer. The public-text extractor remains the privacy boundary; no corpus, generated column, cache, trigger or dual write is needed.

Migration `052_native_history_search.sql` creates the extension in `public` and builds the index transactionally, including existing rows. Conflicting writes wait during the build. Changing the immutable extractor requires rebuilding its dependent index in the same migration. The extension must be preloaded before migration; deployment ordering is documented in `docs/deployment.md`.

The user approved extension-native tokenization, stemming, stopwords, index-wide corpus statistics, scores and tie order. Scoped eligibility still precedes the ranked limit. Rejected: derived corpus and dual writes add synchronization failure modes; `ts_rank` is not BM25; scoring a limited shortlist changes ranking. Exact scoped statistics require reparsing every eligible source record and were rejected for their query cost.

## Version qualification — 2026-10-29 (PDT)

Cloud SQL reports PostgreSQL **17.11**, only `pg_textsearch` **1.3.1** available, extension absent and preload disabled/restart required. PGlite package `0.0.13` embeds **1.5.1**, not hosted-version parity.

Upstream 1.3.1 lacks fixes for recycled-page corruption ([PR 429](https://github.com/timescale/pg_textsearch/pull/429), 1.4.0), deep post-filter retrieval/stable scores ([PR 518](https://github.com/timescale/pg_textsearch/pull/518), 1.5.0) and expression-index insertion ([PR 542](https://github.com/timescale/pg_textsearch/pull/542), 1.5.1). A stored projection does not avoid recycled-page corruption. The initial source-only assessment was no-go without patch evidence; Google's backports remain unverified.

**Decision:** use **1.3.1**, assuming Google fixed these bugs or they are irrelevant—not verified backports. The user rejected waiting for patched 1.5.1+ to avoid delay. Keep the expression index; no projection state is approved. Preload/restart precedes extension creation through two releases (`docs/deployment.md`; resolved question 85 in `docs/open-questions.md`).

1.3.1 doubles candidate redrives up to a default backoff ceiling of 100,000; a planner-pushed large initial SQL `LIMIT` can exceed it. This is neither a universal cap nor a qualified workaround or completeness guarantee.

Local 1.3.1 passed 1,386 warm executions and privacy/DML/WAL-recovery checks. The 2 s benchmark gate remains negative: 9/80 concurrent reads timed out; all 20 writes passed. A controlled reproduction establishes one-CPU runqueue contention for one representative case, not the original nine costs or 1.5.1's cause. No production memory profile or contention SLO is qualified. Protocol, timings, failures and evidence: `docs/testing.md`.

## Retrieval

One statement snapshot applies owner/project/orb scope: Pi uses cursor ancestry; Claude uses all committed records. Deleting projects/orbs are excluded. Public text follows transcript visibility, excluding private overflow, reasoning, image data and tool metadata. Source JSON stays lossless. SQL sanitizes active NUL/unpaired-surrogate escapes before decoding, including private fields, without selecting private text.

The extension tokenizes documents and queries with the English text configuration. Native limits and stopwords apply, including ignored oversized tokens. Ranking uses index-wide statistics, not owner/project/orb-local statistics; corpus changes outside a selected scope can change scores. Equal scores have extension-native order, without a secondary ID sort. The API exposes positive BM25 scores (the negated native distance), highest first.

An ordered BM25 scan applies scope and ancestry before `LIMIT`; nonmatching zero-distance rows are removed afterward. Snippets extract public text only for selected hits and center on literal query terms. A single statement snapshot covers eligibility and retrieval. No query-time corpus parsing, exact candidate count or latency guarantee is part of the contract. The 2 s qualification budget is a benchmark setting, not a production timeout or shipping gate.

## Interfaces

`orb_search_history({query, scope?, orbId?, limit?})` returns native `{hits}` or `{error: OrbAgentError}`. Its shared structured result schema includes both outcomes; replay is safe. The only tool description is:

> Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.

CLI usage: `pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]`

CLI summary: Search your committed public history with BM25.

Runtime transport is authenticated `POST /runtime/v1/history/search`, with queries only in the JSON body. Success is `{v:1,hits}`; each hit has `orbId`, `sessionId`, `recordId`, nullable `name`, `projectName`, `snippet`, `score` and `orbUrl`. Typed failures use existing runtime/CLI status and exit conventions. Responses are no-store.

Default scope is the current orb; `project` means its project; `user` means all this owner's projects/orbs. An explicit orb ID is valid only in orb scope. All scopes are owner-only, narrower than explicit transcript inspection. Owner, project and source orb come from the authenticated caller, never client owner fields. Missing or foreign explicit targets return `not_found`; deleting targets return `conflict`. Limits default to 10 and range from 1 to 50. Queries must contain non-whitespace text and are bounded to 4096 characters; the service trims but never tokenizes them.

`OrbAgentOperations` validates search after its shared actor gate and uses the current project context. Runtime routes bind these operations to the authenticated source orb. Stopped/archived targets need no wake, host access or history pull. Operations add application URLs and log scope, hit count, latency and typed failures, never queries, snippets or database details. Failures remain caller-visible.
