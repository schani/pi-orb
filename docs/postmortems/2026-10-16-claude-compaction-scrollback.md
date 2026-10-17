# Claude compaction hides retained scrollback

Confirmed investigation, captured October 16, 2026, about 23:20 PDT. Target: `c9a30a6d-afb3-4a51-a979-335ae7ac389e`. SQL inspection was read-only; no production mutation, wake, replay or fix.

## Evidence

- SQL retains **6,706 history records, three roots and 87 user records**. Current `orb_transcript` returns only **115 records**, starting at null-parent compaction boundary `ed6997cb-d690-4e59-b78b-93092d6510c6`, October 16 **19:21:46 PDT** (`2026-10-17T02:21:46.226Z`). This chain contains **zero user messages**.
- **38 stored inbox-linked history records** carry **40 delivered inbox IDs**, all outside the current chain. The **42 inbox rows** comprise **40 delivered and two failed**.
- Failed IDs: `3a00e4b8-3161-4f74-a46d-10f4f70baa2f` and `b21f7889-c4e7-40af-9d10-0bf387ad0c05`. Both retain: “User-approved disposition (2026-10-16): native receipt absent; provider consumption unknown. Failed without replay; original text and history retained. Not replayed.” These are not new failures.
- State was **stopped/idle**, `last_error: null`; lifecycle records an idle stop October 16 at **19:45:42 PDT**.

## Mechanism and limits

At investigation, `apps/orb-runtime/src/claude/history.ts` maps native `parentUuid: null` to `parentId: null`; its compact-boundary projection omits `logicalParentUuid`. `apps/control-plane/src/adapters/pg/store.ts` (`readHistory`, around line 2470) follows recursive parent ancestry from the replication cursor and stops at that null parent. Stored older records therefore remain outside the returned transcript: this is a read-reachability failure, not evidence of deletion.

`apps/web/src/components/HistoryView.tsx` (around lines 799 and 881) filters inbox rows by `inboxMessageIds` represented in displayed history, then appends unmatched rows at the tail. Delivered rows disappear only when their IDs are represented. With no user records in the current chain, the prior 40 delivered rows reappear at the tail instead of their historical positions.

The native `logicalParentUuid` for this particular boundary was **not inspected**. No verified native bridge or repair is claimed. Compaction must remain additive to product scrollback (`docs/history-replication.md`); stored-row retention alone does not satisfy that invariant. Remaining rollout work is tracked in `TODO.md`.

Earlier recovery investigation: `docs/postmortems/2026-10-16-c9a30a6d-restart-loop.md`; receipt context: `docs/postmortems/2026-10-15-claude-delivery-uncertain-c9a30a6d.md`. Neither establishes the missing bridge.

## Private evidence

Local files: `/tmp/target-history-index.json` (identity only), `/tmp/target-orb-events.json` (logs), `/tmp/target-inbox.json` (private full content). Never commit these raw files. The initial investigation changed no production code or tests and ran no tests.

## Local correction decision — 2026-10-16

Return all committed Claude replica records on default snapshot reads rather than inventing parent links across compaction; explicit anchors and Pi retain ancestry semantics. This restores retained transcript/provenance access without changing stored history or native state. Rejected naive timestamp sort plus ancestor DFS: a read-only experiment on the actual 6,706 records moved six old messages after compaction. Component-aware Kahn ordering keeps earlier rooted components together and selects timestamp/ID-ready records parent-before-child, with cursor last for browser cache/sync. The database did not retain exact native append ordinals, so unrelated-branch/tie order is deterministic causal presentation, not an exact native append reconstruction. The consistent snapshot and unchanged runtime append/prefix-merge rules are in `docs/history-replication.md`. Implemented and locally qualified; not deployed or live-qualified. Existing incomplete browser memory requires reload.

## Local qualification — 2026-10-16

- Initial red: both Claude store regressions failed on missing pre-compaction history; both Pi controls passed (`/tmp/claude-scrollback-regression-red.log`). An intermediate missing-parent/single-cursor case escaped the traversal count check; explicit parent validation corrected it (`/tmp/claude-scrollback-focused.log`). Invalid timestamps then exposed a nontransitive comparator (one failed, eight passed); mapping invalid `Date.parse` results to zero restores a total order (`/tmp/claude-scrollback-comparator-red.log`). These failures are retained, not cleared by reruns alone.
- Final helper: **9 passed** (`/tmp/claude-scrollback-comparator-final.log`). Memory/PGlite/web focused coverage: **185 passed, four PostgreSQL-only skips**, before two comparator tests were added (`/tmp/claude-scrollback-final-focused.log`). Final-comparator real PostgreSQL: **89 passed** (`/tmp/claude-scrollback-comparator-realpg.log`). Final HTTP/display/headline, web merge/inbox and helper checks: **39 passed across seven files**, including the Claude scrollback HTTP regression (`/tmp/claude-scrollback-final-http-web.log`). Full typecheck passed (`/tmp/claude-scrollback-comparator-typecheck.log`); full lint passed with warnings/info (`/tmp/claude-scrollback-lint.log`).
- Identity-only validation of the incident's **6,706 records** retained every unique record, placed parents before children and cursor last, found zero adjacent message timestamp inversions, and produced identical ordering from reversed input in about **39 ms**; source unchanged (`/tmp/claude-scrollback-incident-order.log`). This does not establish exact append order or independently recount user roles.

No production mutation, deployment, wake or replay occurred. Live resource/browser-reload validation remains unperformed.
