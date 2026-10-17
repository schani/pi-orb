# Claude compaction hides retained scrollback

Read-only investigation, October 16, 2026, 23:20 PDT: `c9a30a6d-afb3-4a51-a979-335ae7ac389e` retained **6,706 records**, but served **115**, starting at a null-parent compaction boundary with no user messages.
Cursor-ancestry traversal stopped there; Claude mapping omitted `logicalParentUuid`. Missing displayed inbox IDs caused 40 previously delivered inputs to appear at the UI tail. This was lost read reachability, not deletion; two existing failed inbox rows were not replayed.
The native bridge was not inspected. Private evidence remains in `/tmp/target-history-index.json`, `/tmp/target-orb-events.json`, `/tmp/target-inbox.json`; do not commit raw content.

**Decision — 2026-10-16:** default Claude snapshots read all committed replica records; Pi and explicit anchors retain ancestry semantics. No stored parents, IDs, cursors, native state or persisted schema change.
Component-aware Kahn ordering keeps rooted components together, parents before children and cursor last. Rejected timestamp sort plus ancestor DFS: an experiment on the incident records moved six old messages after compaction.
Exact native append ordinals were not retained; unrelated branches/ties have deterministic causal presentation, not recovered append order. Contract: `docs/history-replication.md`.

Initial regressions exposed missing pre-compaction records, then missing-parent validation and a nontransitive invalid-timestamp comparator; corrected with explicit validation and invalid timestamps mapped to zero (evidence: `/tmp/claude-scrollback-{regression-red,focused,comparator-red}.log`).
Final checks passed: shared memory/PGlite/PostgreSQL contracts, ordering helper, existing HTTP/inbox tests, and typecheck (`/tmp/pr142-{focused-tests,final-postgres-tests,final-typecheck}.log`).
Identity-only validation retained all 6,706 records, parents before children and cursor last, with identical ordering from reversed input; it does not prove native append order (`/tmp/claude-scrollback-incident-order.log`).

Implemented and locally qualified; **not deployed or live-qualified**. No production mutation, wake or replay. Existing incomplete browser caches require reload.
Receipt context: `docs/postmortems/2026-10-15-claude-delivery-uncertain-c9a30a6d.md`; earlier recovery: `docs/postmortems/2026-10-16-c9a30a6d-restart-loop.md`.

## PR 142 qualification — 2026-10-17

[Central process 2/4](https://github.com/schani/pi-orb/actions/runs/39050866761/job/117448991254), head `2c70c7cf`, failed after the Pi creation POST succeeded: returning Home reported `WebKit encountered an internal error` / `Network process crashed`.
[First artifacts](https://github.com/schani/pi-orb/actions/runs/39050866761/artifacts/12107897482) and logs are preserved in `/tmp/pr142-evidence/`; all 19 uploaded top-level DST traces match committed history.
A diagnostic browser trace shows redundant hard navigations interrupting orb requests and restarting document/module/HMR sessions; it does not establish the native crash cause.
Both engines fail the added no-document-navigation contract before the test-only correction, then pass using the existing SPA Home link. Explicit reload persistence, creation, authentication and privacy assertions remain.
After `npm ci`, the two original cases, workspace/E2E typecheck and scoped lint pass. No native-crash root-cause fix is claimed.
