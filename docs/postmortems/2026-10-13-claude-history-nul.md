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

**Decision (2026-10-13; user-approved; implemented locally, scoped checks passed, broader qualification blocked, not deployed):** store complete history records and session metadata as `JSON.stringify` output in PostgreSQL `TEXT`; `JSON.parse` at the PostgreSQL adapter boundary restores normalized/native strings without loss. Keep structured identity/ordering columns, identity validation, structural duplicate checks and atomic records/cursor/receipts. Reject character stripping/replacement and skipped records. Use the simplest migration, without compatibility staging. Contract: `docs/history-replication.md`; actionable work is tracked once in `TODO.md`.

Local implementation uses `apps/control-plane/src/adapters/pg/history-json.ts`, `store.ts`, migration `044_lossless_history_json.sql` and durable startup header decoding. SQL retains syntax/object checks and relational constraints; schema/identity validation is application-side because SQL field extraction can reject an unrelated escaped NUL. `orb_messages` remains JSONB and is outside this correction.

Exclusive local qualification passed 133 tests in seven files on PGlite and PostgreSQL 15.19; infrastructure checks, workspace typechecks and lint pass. Root typecheck fails on unchanged main E2E DOM typings; overlapping broad/focused runs recorded image, OAuth and setup-hook timeouts with unproven causes. The broad runs were canceled with evidence retained, not passed. An isolated scoped pass does not clear these failures. Details and private evidence: `docs/testing.md`, `.context/history-text/`. No target recovery or deployment has been performed. Invariant polling blockage is still not surfaced to the user; the independent follow-up remains in `TODO.md`. Incident evidence above is unchanged.
