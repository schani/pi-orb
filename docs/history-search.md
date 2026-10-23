# History search

## Decision — 2026-10-22 (America/Los_Angeles)

Search committed public history with exact BM25 using stock PostgreSQL and one GIN expression index on the existing `history_records.record`. Immutable SQL helpers extract public text, normalize/tokenize it and hash terms. PostgreSQL maintains the index for every writer; application history writes remain unchanged. No derived tables, generated columns, backfill, reconciler or commit hooks.

The ordinary transactional migration builds the index over existing rows and blocks conflicting writes during its scan. Subsequent writes maintain it automatically, including writes from older application processes. No special first-rollout maintenance gate or migration runner is needed. Changing an immutable extraction/tokenization helper requires rebuilding its dependent index in the same migration.

Rejected: application dual writes and a derived search corpus add synchronization and rollout failure modes. `ts_rank` is not BM25. Computing scores from a limited candidate shortlist would change the ranking.

## Retrieval

One statement snapshot applies owner/project/orb scope and committed-history eligibility: Pi uses cursor ancestry; Claude uses all committed records. Deleting projects/orbs are excluded. Public text follows transcript visibility; private overflow, reasoning, image data and tool metadata are not indexed or returned. Source JSON remains lossless and unchanged. SQL sanitizes active NUL and unpaired-surrogate escapes before JSON decoding, including escapes in private fields, without selecting those fields into public text.

Documents and queries share SQL NFKC normalization, Unicode lowercasing under `C.utf8` and `[[:alnum:]]+` tokenization. No stemming or stopwords. Combining marks not composed by NFKC separate tokens. The database must provide `C.utf8`; collation/provider upgrades can require reindexing. MD5 term keys avoid GIN's key-size limit; exact full-token rechecks make hash collisions harmless.

BM25 uses `k1=1.2`, `b=0.75`, exact scoped `N`, average document length, document frequencies and full term frequencies. Empty-token documents are excluded. All matching candidates are scored before the limit; ties use orb ID then record ID in C order. Snippets come from the same public-text extraction.

**Cost:** exact corpus statistics require parsing/tokenizing all eligible scoped source records at query time, including nonmatches. The GIN predicate narrows matching candidates, not this corpus-statistics work. The planner may choose another index. No latency guarantee.

## Interfaces

`orb_search_history({query, scope?, orbId?, limit?})` returns native `{hits}` or `{error: OrbAgentError}`. Its shared structured result schema includes both outcomes; replay is safe. The only tool description is:

> Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.

CLI usage: `pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]`

CLI summary: Search your committed public history with BM25.

Runtime transport is authenticated `POST /runtime/v1/history/search`, with queries only in the JSON body. Success is `{v:1,hits}`; each hit has `orbId`, `sessionId`, `recordId`, nullable `name`, `projectName`, `snippet`, `score` and `orbUrl`. Typed failures use existing runtime/CLI status and exit conventions. Responses are no-store.

Default scope is the current orb; `project` means its project; `user` means all this owner's projects/orbs. An explicit orb ID is valid only in orb scope. All scopes are owner-only, narrower than explicit transcript inspection. Owner, project and source orb come from the authenticated caller, never client owner fields. Missing or foreign explicit targets return `not_found`; deleting targets return `conflict`. Limits default to 10 and range from 1 to 50. Queries must contain non-whitespace text and are bounded to 4096 characters; the service trims but never tokenizes them.

Stopped and archived targets need no wake, host access or history pull. The service adds application URLs and logs sanitized scope, document/candidate/hit counts, latency and typed failures, never queries, snippets or database error details. Failures remain caller-visible.

## Validation

Existing protocol, service, runtime-route, native codemode and CLI fixtures cover shared shapes, owner binding, stale credentials, integer limits, typed object results/errors, privacy and dispatch. Shared PostgreSQL/PGlite contracts exercise extraction, BM25, eligibility, source-only writes and expression-index access. The existing Durable native-alert script searches only after its committed alert receipt; the full-slice fixture searches a stopped orb through the running sibling CLI.
