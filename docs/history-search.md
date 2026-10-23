# History search

## Decision — 2026-10-22 (America/Los_Angeles)

Search committed public history with exact BM25 using stock PostgreSQL and one GIN expression index on `history_records.record`. Immutable SQL helpers extract/tokenize public text and hash terms; PostgreSQL maintains the index for every writer.

The ordinary transactional migration indexes existing rows, blocking conflicting writes during the build. Changing an immutable extraction/tokenization helper requires rebuilding its dependent index in the same migration.

Rejected: dual writes and a derived corpus add synchronization/rollout failure modes; `ts_rank` is not BM25; scoring a limited shortlist changes ranking.

## Retrieval

One statement snapshot applies owner/project/orb scope: Pi uses cursor ancestry; Claude uses all committed records. Deleting projects/orbs are excluded. Public text follows transcript visibility, excluding private overflow, reasoning, image data and tool metadata. Source JSON stays lossless. SQL sanitizes active NUL/unpaired-surrogate escapes before decoding, including private fields, without selecting private text.

Documents and queries share SQL NFKC normalization, Unicode lowercasing under `C.utf8` and `[[:alnum:]]+` tokenization. No stemming or stopwords. Combining marks not composed by NFKC separate tokens. The database must provide `C.utf8`; collation/provider upgrades can require reindexing. MD5 term keys avoid GIN's key-size limit; exact full-token rechecks make hash collisions harmless.

BM25 uses `k1=1.2`, `b=0.75`, exact scoped `N`, average document length, document frequencies and full term frequencies. Empty-token documents are excluded. All matching candidates are scored before the limit; ties use orb ID then record ID in C order. Snippets come from the same public-text extraction.

**Cost:** exact statistics parse/tokenize every eligible scoped source record at query time, including nonmatches. GIN narrows candidates, not statistics work; the planner may choose another index. No latency guarantee.

## Interfaces

`orb_search_history({query, scope?, orbId?, limit?})` returns native `{hits}` or `{error: OrbAgentError}`. Its shared structured result schema includes both outcomes; replay is safe. The only tool description is:

> Search your committed public history with BM25. Defaults to this orb; project searches this project and user searches all your orbs. Returns ranked snippets; use orb_transcript for full context.

CLI usage: `pi-orb search QUERY [--orb ID | --project | --all] [--limit N] [--json]`

CLI summary: Search your committed public history with BM25.

Runtime transport is authenticated `POST /runtime/v1/history/search`, with queries only in the JSON body. Success is `{v:1,hits}`; each hit has `orbId`, `sessionId`, `recordId`, nullable `name`, `projectName`, `snippet`, `score` and `orbUrl`. Typed failures use existing runtime/CLI status and exit conventions. Responses are no-store.

Default scope is the current orb; `project` means its project; `user` means all this owner's projects/orbs. An explicit orb ID is valid only in orb scope. All scopes are owner-only, narrower than explicit transcript inspection. Owner, project and source orb come from the authenticated caller, never client owner fields. Missing or foreign explicit targets return `not_found`; deleting targets return `conflict`. Limits default to 10 and range from 1 to 50. Queries must contain non-whitespace text and are bounded to 4096 characters; the service trims but never tokenizes them.

`OrbAgentOperations` validates search after its shared actor gate and uses the current project context. Runtime routes bind these operations to the authenticated source orb. Stopped/archived targets need no wake, host access or history pull. Operations add application URLs and log scope, document/candidate/hit counts, latency and typed failures, never queries, snippets or database details. Failures remain caller-visible.
