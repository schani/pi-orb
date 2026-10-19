# Peer inbox stalled after model failure — 2026-10-18

## Evidence (read-only)

Target: [orb `6776c7ee-d852-42ba-8f18-6257d5bd1b81`](https://pi-orb-issuer-1077475695242.us-central1.run.app/orbs/6776c7ee-d852-42ba-8f18-6257d5bd1b81). Snapshots: October 18, 2026, 5:43–5:44 PM PDT; SQL `read_only: on`. Source checkout `6cd6d79b` does not establish deployed-byte parity. Sanitized source: `/tmp/orb-queue-inspect/sanitized-evidence.json`; no input bodies or credentials retained here.

- SQL: 99 peer and 3 human messages delivered, 1 peer delivering, 42 peers queued; all 103 claimed batches singleton.
- Last delivery `90cfa85b-1b56-4c57-862c-7d0a3ade0fda` at 1:37:42 PM PDT: Native submission669 `unanswered/model_error`. Generation670 failed at 1:38:18 PM PDT with provider diagnostic “This content was flagged for possible cybersecurity risk.” This records a refusal, not an input assessment.
- Head `2e21ffc3-a554-49b1-8ced-944c40f51113`, created 1:38:06 PM PDT, remained SQL `delivering/steer`, referencing prior submission669; its own submission671 remained Native `queued`.
- SQL `updated_at` refreshed through 5:44:52 PM PDT with zero Native active tasks and no delivery progress; timestamp refresh did not demonstrate consumption.

## Mechanism and limits

Singleton dispatch limits throughput but does not explain the four-hour stall. Inspected `/app` `pi-durable@1.3.0` `generation.js:406–442` settles failed input as `unanswered/model_error` and clears `pi.live.run` without applying the inbox boundary; `submissions.js:132–140` returns duplicates before idle-queue progress. Resume schedules only existing tasks, stranding queued input when no task remains.

Local deterministic tests reproduce this scheduling defect, not the live incident: snapshots omitted `pi.live`/`pi.inbox`, and deployed-byte parity was not verified. No target mutation, replay, deployment or live recovery occurred; no claim is made that retrying the refused input would recover it.

## Tests-first evidence

`queued-model-error.test.ts` holds a provider request, admits steering input, then releases terminal failure: queued input must finish under its original ID without repeating failed-run effects. `agent-backlog.test.ts` and existing agent/operation-identity/central-dispatch fixtures cover atomic admission, receipts, handoff, duplicate-only batch drain and guarded reopen; passive open stays inert.

Initial RED logs under `/tmp/`: `queued-model-error-complete-red.log` (four drain/duplicate/reopen/guard failures; later-input control passed); `native-backlog-first-failure.log` (missing `submitMany`); `backlog-store-red.log` (ten missing-claim failures); `native-compaction-corrected-first-failure.log` (stranded input after declined compaction; initial fixture failure in `native-compaction-first-failure.log`).

Receipt-race REDs: `/tmp/agent-backlog-race-first-failure.log`, `/tmp/provisional-{settled,active}-red.log` expose stale steering classification, missing canonical IDs and adoption of unrelated active work. The broader retry-boundary experiment (`/tmp/native-retry-first-failure.log`) was dropped as unrequested; existing steering boundaries suffice.

Contract/invariants: `docs/orb-messaging.md`; protocol: `docs/runtime-protocol.md`; qualification and retained DST failure/replay evidence: `docs/testing.md`.
