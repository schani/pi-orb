# Claude history NUL blocked replication — 2026-10-13

## Confirmed evidence

Read-only inspection of orb `4647f261-2126-4f20-a61c-51095d222a47`; all times PDT on October 13. No target restart, write or deployment.

- At 11:42, live health was ready/idle, not a stuck agent. Live history contained 409 records; operation `d0c06f35-7ec6-41be-a047-488713af38fa` completed at 10:24:35.142.
- First NUL-bearing record: binary-excerpt tool output `8a94c286-a676-4161-a9bf-dd4540a7d26f`, 10:08:45.754. Its 4,925-character Latin-1-decoded Claude executable excerpt contained 212 NULs, duplicated in normalized text and two native overflow fields. No unpaired surrogates were found. A second tool record at 10:14:21.465 contained 242 NULs per field.
- PostgreSQL reported `unsupported Unicode escape sequence`; lifecycle `pull-failed` logged `invariant=true` at 10:08:53.078 and 10:46:48.483. Invariant failures park history polling in that control-plane process.
- All SQL branches contained 111 records, exactly live indices 0–110; live history contained 409. Cursor/head `b0b6016f-80c8-4dce-82c1-29f395dcacea` was at 10:08:41.073. Cursor ancestry alone contained 83 records, not the full SQL inventory.
- Inbox `586484ee-e246-47f3-a93b-65ef49cdc78e` remained `delivering` despite completed operation `d0c06f35`; later `f43bb2da-06c7-40bb-9040-cfd9b82cee7d` and `d5c22c24-f73b-4608-9506-515474707944` remained `queued`.

Private evidence: `.context/orb-4647f261-readonly/{interim.md,unicode-findings.json,sql-inspection-result.txt,sql-live-comparison.json}`. The completed all-branch SQL comparison supersedes the interim report's pending inventory check. Raw payloads are not published.

## Cause and FIFO blockage

JSON permits escaped NUL (`\u0000`); PostgreSQL JSONB rejects it. The replica's JSONB representation could not store valid runtime history. The failing pull transaction could commit neither records/cursor nor inbox receipts. Later live completion therefore did not establish control-plane delivery.

`delivered` advances only when the history receipt commits. `claimNextOrbMessageBatch` always returns the oldest outstanding batch, so retries kept selecting `586484ee` rather than admitting later queued messages. A healthy idle runtime and ongoing inbox retries do not prove replication or receipt progress.

## Requirement and approved correction

**Required correction (2026-10-13):** replica storage must losslessly round-trip valid history strings, including NUL in normalized and native overflow fields; deleting/replacing characters or skipping records is not acceptable. Receipt and cursor atomicity must remain intact.

**Decision (2026-10-13; user-approved; deployed later that day):** store complete records/session metadata as PostgreSQL `json`, not `jsonb`. Drivers decode whole values; SQL payload field processing remains forbidden because it can reject escaped NUL/unpaired UTF-16. Preserve relational constraints, duplicated identity guards, structural duplicates and atomic records/cursor/receipts. No stripping, skipping or compatibility staging. Contract: `docs/history-replication.md`; follow-ups: `TODO.md`.

## Qualification evidence

Historical TEXT candidate `1008ea2` passed 133 exclusive scoped tests, infra, workspace TS and lint; root TS reproduced main's E2E DOM-typing errors ([main CI](https://github.com/schani/pi-orb/actions/runs/38439785390/job/115443062499), PR job `115504974206`). Evidence remains in `.context/history-text/`: tests-first logs, source hashes, `exclusive-focused.log`, `baseline-e2e-typecheck.log`; `local-codec-summary.md` measures only that candidate. Whole-JSON Unicode/structural-duplicate experiments passed PGlite/PostgreSQL 15.19 (`.context/pr90-simplify/json-cast-duplicate-proof.log`). Neither qualifies the current JSON source.

First overlapping runs recorded image/OAuth 30-second timeouts and PGlite 10-second setup-hook timeouts; causes remain unproven. Broad runs were canceled, not passed (`.context/history-text/{full-tests.log,final-unit.log,final-focused.log,cancelled-owned-processes.json,cleanup-second-pass.json}`). Two-CPU overlap and the image sandbox's 300-second deadline without forwarded abort are observations, not diagnoses.

`1a68b06` [E2E 2/4](https://github.com/schani/pi-orb/actions/runs/38462215701/job/115520003503) hit the Docker-build 600-second deadline at layer export after ~512-second npm install; cause unproven, no tests ran (`.context/pr90-simplify/ci-e2e-first-failure.log`). Its eight CI migration-list failures omitted 044, corrected by `6e5c282`; 38 exclusive PGlite/real-PostgreSQL contracts passed (`ci-checks-first-failure.log`, `ci-checks-failures.json`, `google-identity-correction.json` in `.context/pr90-simplify/`). The 19 uploaded DST traces are tracked and byte-identical, not new failures.

**JSON qualification (2026-10-13):** both-driver TEXT→JSON RED is preserved in `.context/pr90-json/red.log`. The JSON implementation passed 259 affected contracts/startup/backfill/atomicity/FIFO tests; four PGlite cases require independent real-PostgreSQL connections and passed there. Root TS, lint, infra and source hashes passed (`qualified-*` evidence in `.context/pr90-json/`). The first TS failure and deterministic generic-inference diagnosis remain in `final-typecheck.log` and `typecheck-diagnosis.md`. New-head CI is pending. At that point, historical timeouts/Docker qualification remained blocked; no deployment or recovery occurred.

## Scoped release exception

**Decision (user-approved 2026-10-13, PDT):** “I don't care, go ahead with deploy!” waives historical explanation of only the overlapping local image/OAuth/PGlite timeouts above, PR 90 `1a68b06` Docker-build deadline and prior WebKit readiness failure below. Causes remain unknown; no fix or passing rerun clearing them is claimed. Preserve first-failure evidence. Normal exact-head qualification, correction of new failures and DST replay remain mandatory; no gates are bypassed. This documentation task dispatches no deployment or recovery.

[Durable qualification 38468937890, Central process 1/4](https://github.com/schani/pi-orb/actions/runs/38468937890/job/115542687858), at `44094c064d723189b5433cfeaa396c05928b208d`, failed the WebKit shared-project-header case in `e2e/harness-icons-frontend.e2e.test.ts:135`: readiness timed out waiting 30 seconds for a request. Its snapshot recorded a pending document request, no new navigation/module checkpoints and access-control fetch errors; these do not establish the cause. Evidence remains in `.context/deploy-ab8c9c7/{run-38468937890.log,run-38468937890.json,artifacts-38468937890.json}` and the linked Actions run. This exception does not cover other WebKit failures.

## Deployed qualification (2026-10-13, PDT)

Exact-head CI, all four Docker E2E shards and all four Central process shards plus image qualification passed on attempt 1 at `66479dffe6da964b5b2e50094a7d9852949ba213`. [Deploy 38484755289](https://github.com/schani/pi-orb/actions/runs/38484755289) applied migration 044 at 17:05:57 and validated all twelve transaction gates at 17:41:28. The workflow subsequently failed on monitor outcome `regression`, not the transaction. No clean monitor, historical-timeout fix or original-orb recovery is claimed; production catalog/ledger were not independently queried. Earlier checkpoints and scoped waivers above remain unchanged.

Release/verification evidence: `docs/deployment.md`, `.context/deploy-38484755289/{qualification,artifacts,verification}/`. Monitor attribution and limits: `docs/postmortems/2026-10-13-rollout-monitor-anomalies.md`.
