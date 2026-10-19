# Peer inbox stalled after model failure — 2026-10-18

## Evidence (read-only)

Target: [orb `6776c7ee-d852-42ba-8f18-6257d5bd1b81`](https://pi-orb-issuer-1077475695242.us-central1.run.app/orbs/6776c7ee-d852-42ba-8f18-6257d5bd1b81). Snapshots: October 18, 2026, 5:43–5:44 PM PDT; SQL transaction reported `read_only: on`. Source inspection: checkout `6cd6d79b`, not proof of the deployed revision. Sanitized source: `/tmp/orb-queue-inspect/sanitized-evidence.json`; essential observations retained here, without input bodies or credentials.

- SQL: 99 peer and 3 human messages delivered, 1 peer delivering, 42 peers queued. All 103 claimed batches were singleton.
- Last delivery: `90cfa85b-1b56-4c57-862c-7d0a3ade0fda` at 1:37:42 PM PDT. Native submission 669 was `unanswered`, reason `model_error`.
- Generation 670 failed at 1:38:18 PM PDT. Provider diagnostic: “This content was flagged for possible cybersecurity risk.” This records a provider refusal, not an assessment of the input.
- Head `2e21ffc3-a554-49b1-8ced-944c40f51113`, created 1:38:06 PM PDT, remained SQL `delivering` / `steer`; its operation ID referenced prior submission 669. Its own Native submission 671 remained `queued`.
- SQL `updated_at` refreshed through 5:44:52 PM PDT without delivery progress. Native active-task count was zero. Thus timestamp refresh alone did not demonstrate consumption.

## Mechanism and attribution limits

Singleton dispatch limits backlog throughput but does not explain the four-hour stall. In the inspected `/app` installation, `pi-durable@1.3.0`'s `generation.js:406–442` settles failed input as `unanswered` on `model_error` and clears `pi.live.run` without applying the inbox boundary, unlike success. `submissions.js:132–140` returns an existing duplicate before idle-queue progress logic. Resume schedules existing tasks only, so queued input can remain stranded with no task.

Deterministic local tests reproduce this defect below. They do not prove the live incident's exact cause: deployed-byte parity was not verified, and the snapshot omitted `pi.live`/`pi.inbox` documents. No target mutation, replay or live recovery was performed.

## Tests-first reproduction (2026-10-18, America/Los_Angeles)

`apps/control-plane/src/adapters/durable/queued-model-error.test.ts` holds a faux provider request, admits steering input, then releases a terminal model failure. The failed submission becomes `unanswered/model_error`; the queued input must finish under its original Native ID without repeating the failed run's tool effect. Separate cases seed the resulting no-task/queued-input state to test duplicate-ID delivery, later input, active reopen and denied recovery admission; passive open must remain inert.

Initial evidence, retained before fixes:

- `/tmp/queued-model-error-complete-red.log`: four failures exposed terminal-error drain, duplicate-ID progress, reopen and recovery-guard gaps; the later-input control passed (five cases total).
- `/tmp/native-backlog-first-failure.log`: both idle/busy finite-snapshot tests failed because `Conversation.submitMany` did not exist.
- `/tmp/backlog-store-red.log`: ten failures across in-memory/PGlite store contracts exposed the missing full-backlog claim API.
- `/tmp/native-retry-first-failure.log`: admitted steering input was absent from provider retry context.
- `/tmp/native-compaction-corrected-first-failure.log`: queued input remained stranded after overflow compaction declined. The earlier `/tmp/native-compaction-first-failure.log` retains the initial fixture failure.
- `/tmp/agent-backlog-race-first-failure.log`: preflight/provisional-commit races classified a new turn as steering the finished operation.
- `/tmp/provisional-settled-red.log` and `/tmp/provisional-active-red.log`: settled provisional retries lacked canonical Native operation IDs or retargeted a newer active operation. Recovery uses transient Native-status bookkeeping; stale historical Abort cannot target the new operation.

These are local defect/API reproductions, not a replay of live submissions 669/671 or proof that the provider refusal is recoverable by retrying failed input.

## Decisions (2026-10-18, America/Los_Angeles)

**Implemented locally; qualification pending (`docs/testing.md`).** No deployment or live recovery is authorized or performed. No new persisted fields or schema.

- Admit central Pi's finite FIFO backlog through one atomic Native input-only `Conversation.submitMany`, retaining human-contiguous/system-singleton batch identities, sender attribution and separate receipts. Singleton provenance is not an inference boundary.
- Apply admitted input before provider retry preparation without changing backoff/run ownership. On terminal `model_error`, settle failed input, then drain queued input without replaying the failed run.
- Duplicate queued request IDs must progress an idle inbox. Active reopen must pass recovery/admission guards before restarting queued input, even with no active task; passive open stays inert.
- Classify fresh/queued receipts from Native admission-commit ownership plus postcommit aggregate activity. Finalized duplicates retain operation/delivery. Never-finalized settled retry partitions share the snapshot's first such Native submission ID as a canonical fallback and retain provisional delivery; historical busy-run ownership is not reconstructed, and unrelated current operations are never adopted. Native's `{submissions,busy,inputId?}` is transient; no historical scan or new persisted state.
- Retain content-free recovery decisions in the lifecycle log. Existing Native submissions/history, receipts and per-partition delivery/failure edges correlate admission, consumption and visible outcomes without message/provider bodies.

Admission contract and rejected alternatives: `docs/orb-messaging.md`; protocol: `docs/runtime-protocol.md`. Local qualification and campaign-fixture failure/replay evidence: `docs/testing.md`.
