# Claude root activity during query shutdown

Date: 2026-10-13 (America/Los_Angeles). Confirmed adapter defect corrected locally; historical incident attribution remains incomplete. No deployment or failed-orb replay.

## Retained incident evidence

Orb: `ec07528b-6c09-4901-8972-cf6a17741c13`; native session: `7fbec813-a5bd-4bb5-90dc-6d3044b1455c`.

| PDT | Evidence |
| --- | --- |
| 06:09:15.632 / .648 | Native records `86dcc461-3a48-464d-b797-32f6a79460f7` and `80a31262-1db1-4990-9d50-081642f90bab`: two background Bash completion notifications. |
| 06:09:24.227 | Tool result `6f7e629a-31bc-4301-8d76-e5860cd6b21f`: commit `8fd02d3` pushed. |
| 06:09:35.548 | Tool result `d77728c0-7d1a-4253-bd5d-0829ad45ad46`: [PR 87](https://github.com/schani/pi-orb/pull/87) created. |
| 06:09:39.549 | Retained native final reply `76f113ca-6cb6-415e-9bd1-296757458959`, parent `7af070a2-c27e-4453-b31c-f0f64e99f4a4`, `stop_reason: end_turn`. It reports that task's PR and qualification. |
| 06:09:40.710 | Local `claude.handoff_interrupted`: task `bzppevrdv` start/terminal observed during closing; query `70e91081-85a3-46e2-8cc1-f3ab4e3fe153`, operation `f9cb60d1-d456-49c8-aca3-0067cb36a3fc`. No automatic replay. |
| 06:09:40.769 | Local `claude.rotation_failed`, `reason: root_work`, visible failure requiring inspection. |
| 06:09:46.709613 | Control-plane lifecycle: `runtime-failed reason=claude_rotation_uncertain incarnation=0`. |
| 06:10:09.534673 | Lifecycle: compute discarded, outcome `ok`. |

Sources: replicated transcript; Cloud Logging `projects/playground-dev-6ae7/logs/run.googleapis.com%2Fstdout`; retained native JSONL, normalized index, session and provenance. The replicated transcript ends at attachment `8f8ccdae-c5da-4fed-9af8-1989dff441ad` (06:09:35.556), before the final reply and local failure records.

The VM was absent. The detached data disk was attached read-only and mounted `ro,noload`; evidence was copied without recovery, replay or disk writes, then unmounted and detached. Temporary user credentials were revoked; the deployer account was restored. Copies remain in ignored `.context/claude-rotation-ec07528b/retained/`.

SHA256:

- `native.jsonl`: `60b05fb082ee1b8b4874e4935f12ac49f4ebb32a18de0c362a7ef272b7883c97`
- `index.json`: `407ab87f17f3efa9fa8f54555786de744943b46b2f1ae9e7bf31e28aa938dbf7`
- `session.json`: `bb4c15e9a8617ee3d170dc26767c0c76142d74bf9ba0e82b3719d24b68d9bfa3`

The retained session has empty task/handoff inventories. That is not proof of an idle fence. Native transcripts do not record every SDK status/result or input-close signal. `root_work` establishes when the adapter observed requesting/root-assistant output, not when inference began. Inspected repository baseline `00205af` is not attribution of the deployed runtime revision.

## Reproduced defect

Pinned SDK **0.3.289**, native CLI **2.1.289**. An owned loopback provider asks the real native CLI to start two background Bash commands blocked on FIFOs. The first schedule releases those commands after the first inference result. Native output contains:

1. Terminal task notifications and empty inventory.
2. Successful command result: `num_turns: 0`, `stop_reason: null`, empty result, `queued_turn_count: 0`.
3. Root `status: requesting`, assistant/tool work, then a nonzero-turn root result.

Published `queued_turn_count` excludes system-generated queue entries. Native implementation emits the zero-turn result on its `shouldQuery: false` path. It acknowledges a command, not completion of the following root inference.

The prior adapter unconditionally cleared task handoffs on result and admitted query shutdown at step 2. The real CLI still executed step 3 after input closed. The adapter then correctly failed closed with `claude_rotation_uncertain`. The defect is premature shutdown admission, not the uncertainty guard.

A second controlled schedule releases both commands during a held root response. After both terminal notifications, the provider finishes that earlier response. Its nonzero-turn result also precedes the queued acknowledgment and actual continuation. The zero-turn-only correction still failed with `claude_rotation_uncertain`; native and four DST cases reproduced it. A result with inference is insufficient unless that inference started after the notification.

`task-handoff-native.test.ts` joins real native input/output, process exit and filesystem transcripts to production adapter ownership/history code through the composed fixture. Metadata bootstrap/process ports and journal storage use fixture boundaries; native inference/Bash/SDK output are not synthetic. Dummy authentication, fresh home/configuration, an environment whitelist and the existing seccomp supervisor allow only the owned loopback provider. No external provider or incident work is replayed.

This reproduces a concrete adapter defect consistent with the incident. **The incident's exact SDK-result ordering is not established**, so this is not claimed as its proven historical cause.

## Correction and observability

Decision (2026-10-13): snapshot pending handoffs on root `requesting`. Only a nonzero-turn result may finish those handoffs. Zero-turn acknowledgments, older inference results and assistant output cannot consume a handoff without that subsequent requesting edge. Tasks finishing during synthesis remain owned for another requesting/result pair. Live and durable ownership retire identical IDs. Local zero-turn commands without handoffs retain normal completion. No grace timer, session replay, relaxed late-work guard or automatic compute recovery is added.

`claude.handoff_result` durably records each result with pending handoffs: query/operation/result IDs, turn/queued counts, completed/pending task IDs and those awaiting inference, hidden from routine UI output. `claude.rotation_failed.rootWork` records the first late requesting/root-assistant signal and prior result ID, turn count, stop reason and queued-user count. Failure remains visible, busy and non-admitting. Diagnostic persistence failure also blocks admission. Result text, prompts and credentials are excluded. This evidence does not depend on nested-delegation-denial diagnostics.

## Regression evidence

Existing late-root tests qualified containment only. Their fake producer did not emit zero-turn acknowledgments and `emit()` waited for consumer acknowledgment. The native regression now requires completed operation and ready/idle health. DST adds zero-turn command results, inventory removed before/after terminal notifications, and `enqueue()` for producer output buffered independently of adapter consumption. All eight release/inventory/buffering schedules require completion without rotation failure; a partial-consumption scenario verifies both ownership layers, and local-command and publication-failpoint tests protect adjacent behavior.

The original immediate-assertion traces reproduced before fixing. They end at the old failure site; strict post-fix replay exhausts them after crossing that site, rather than inventing a new schedule. Full-schedule assertions retain four additional baseline-failing traces, each explicitly replayed against the prior implementation and passing unchanged against the correction:

- `claude-task-command-ack-before-acknowledged-1791899829710-0.json`
- `claude-task-command-ack-before-buffered-1791899829749-0.json`
- `claude-task-command-ack-after-acknowledged-1791899829776-0.json`
- `claude-task-command-ack-after-buffered-1791899829790-0.json`

Evidence lives in ignored `test-failures/` and `.context/claude-rotation-ec07528b/`. The native regression fails against the prior adapter at premature acknowledgment closure. The initial correction passed 301 Claude tests but did not cover completion during inference. Four additional in-flight traces were explicitly replayed before strengthening the handoff fence and pass against that correction:

- `claude-task-command-ack-before-acknowledged-during-response-1791901544898-0.json`
- `claude-task-command-ack-before-buffered-during-response-1791901545054-0.json`
- `claude-task-command-ack-after-acknowledged-during-response-1791901545239-0.json`
- `claude-task-command-ack-after-buffered-during-response-1791901545376-0.json`

The broader Claude run then exposed seven replayed DST failures and two ordinary failures in existing fixtures: successful handoffs omitted requesting, and empty guard maps relied on unconditional replacement. Producers now supply the native requesting edge; empty-map initialization preserves existing handoffs. Success/uncertainty assertions remain unchanged. A new partial-consumption fixture's incorrect `children` property reproduced under replay and was corrected to `LiveOperationView.subagents`. Typecheck also caught two symbolic-UUID casts, corrected at the test boundary.

The first full-unit call ended with an execution transport failure before a suite verdict. Its two cross-layer archive/restart DST failures were explicitly replayed before correcting the same missing requesting edge in their producers; all seven cross-layer cases then passed with unchanged assertions. A later VM restart interrupted another qualification attempt. Logs and first-failure traces remain retained.

Local qualification before rebasing onto updated `main` (baseline `00205af`): **4,556 unit tests passed, seven skipped** (666 files passed, one skipped), with isolated PostgreSQL 15 over a Unix socket; infrastructure tests, workspace/E2E typecheck, lint and `git diff --check` pass. Both real-native release schedules and all DST completion regressions are included. A SHA256 manifest verifies the non-Markdown source is unchanged across qualification.

Process/PGlite full-slice E2E passed all four cases on unchanged source, including login, tool round trip, replication, drain and explicit restart. The first invocation was canceled at the tool's 240-second budget before a verdict; its log is retained. The completed run's first case took 333 seconds, without changing test deadlines or assertions. This is scoped full-slice coverage, not qualification of the entire E2E suite. No deployment.

Historical attribution is tracked in `TODO.md`. General native idle-fencing equivalence remains question 73 (Claude SDK) in `docs/open-questions.md`.
