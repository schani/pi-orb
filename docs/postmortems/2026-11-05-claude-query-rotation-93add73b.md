# Claude shutdown race: 93add73b

2026-11-05; times PST (America/Los_Angeles). Orb `93add73b-2895-4000-8a7a-1eaf6372e8b6` failed `claude_rotation_uncertain`. Initial close remains unexplained.

## Observed

- VM image: `pi-orb-image-v-aa1c45d1-e0487fa2f63042a7`. Audit records Spot preemption at **13:08:25.799600**, then the same VM running at **13:09:48**: not a deploy replacement.
- **14:04:22.881:** previous operation completed.
- **14:04:35.060:** synthetic stopped notification for task `b0u8gqwbs`; **35.204:** human asks “What all did we deploy?”
- **14:04:38.426:** Bash result; **38.459:** SDK API-request record.
- **14:04:43.225:** retained native transcript and local index contain root assistant `8f1e6469-bedf-4da0-9715-614f5a0c0f46`, `end_turn`, answering with #264/#261. **43.362:** `claude.model_call`, `querySource: sdk`, `claude-opus-5-5`, 4,856 ms, `outcome: ok`.
- **14:04:43.717:** local index records `claude.rotation_failed`, `reason: root_work`, query `23b7286b-1e02-4a02-8561-3c7335d22970`, signal `requesting`. Its preceding result reports success, zero turns, zero queued turns, null stop reason. Final task/child/handoff inventories are empty.
- **14:04:53.662136:** lifecycle detects failure; compute discarded at **14:05:16.660930**. The initial central transcript lacked the local final answer/failure edge.

## Interpretation

In `aa1c45d1`, `agent.ts:1646–1653` replaces `lastRootResult` even during closing. Thus `priorResult` does **not** identify the initial close trigger.

Source-supported hypothesis: an unowned zero-turn completion drained while the initial human turn remained pending. `agent.ts:1720–1723` accepts zero queued turns without pending steers; `activity.ts:90–99` marks root done without handoffs even for zero-turn results. Only steering inputs enter `pendingSteers` (`agent.ts:2400–2402`). This mechanism is possible, not established here.

Installed SDK 0.3.318/CLI 2.1.318 maps query-loop `stream_request_start` to SDK `requesting`, before API preparation. This is a query-loop signal, not a title-generation marker; provider-request timing remains unproved. Its metadata reappend routine writes existing title/PR-link fields; adjacency proves no causality. Retained runtime bytes were not inspected. Image baseline predates #261 first-close diagnostics.

## Preservation

Authorized inspection used a separate inspector, read-only attachment, block-device read-only enforcement and `ro,noload,nodev,nosuid,noexec`; no journal replay, target execution, repair or recovery. Serial evidence records clean unmounts; source hashes match across inspections. Independent checks confirm retained disk `3660100527708003295` detached, `READY`, without users, and inspector VM/boot disk absent. Temporary human login was revoked; active deployer restored. Private evidence: `.context/claude-rotation-93add73b/`, including `retained/projection.json` and `retained/final-projection.json`.

Retained source SHA-256:

| File under `claude/` | SHA-256 |
|---|---|
| `session.json` | `230d08468a8c513a3adbc21925516de485ab6765829a37fd400570ed8526dad6` |
| `provenance.json` | `1b4007090e1915bc926c29190545a4c960dadc10646e787f698e6c8e995187a8` |
| `index.json` | `97c8f74a2104225409b4e19f2c21171123632a80ad95e92fd9fc71ffc9351218` |
| `config/projects/-workspace-repo/723f63c2-3c1c-4444-8978-fff850bcf36f.jsonl` | `92ec0ee81118e2f4eef36fb7a8d21fabb9f315a5d3f6c7f7ebaec60ae080dada` |

## Recovery

User authorized recovery on 2026-11-05. Read-only checks found all three inbox messages delivered with their original operation IDs and exact native input receipts. Retained ownership inventories were empty; the last assistant message was `end_turn`. Startup checks submitted delivery receipts before attaching and treats that settled tail as a passive restart, not an interrupted turn. No offline repair was indicated.

The matching-version local CLI rebuilds background-shell ownership from transcript tool results, not a separate shell-task file. Its orphan scan suppresses IDs already present in persisted task notifications. Native row `08072553-6544-455e-b4b7-bc7a58328eca` already records task `b0u8gqwbs`, status `stopped`, `queueTranscriptOnly: true`; normal full-transcript restoration therefore has suppression evidence. Monitor timeout can leave no terminal transcript marker, explaining why a later fresh query can report an already-ended shell as orphaned. This does not establish that the notice caused the shutdown race. No task files or history were deleted.

**14:47:47:** one ordinary start request. **14:49:12:** replacement incarnation 1 reached `running`; subsequent resource read reported `idle`, checkout `1c8d072d`, same native session. Replication recovered the retained final answer and `claude.rotation_failed` event. The durable restart marker records `host_restarted` without an operation ID; lifecycle reports `notified_restart`, headed by the final answer. No new model-call/API-request records, tool calls or automatic turn were observed. Inbox delivery receipts remained unchanged. No test message was sent; this establishes startup recovery, not correction of the underlying race.

Evidence: `.context/claude-rotation-93add73b/recovery/` contains before/after API receipts, transcript, lifecycle events and bounded CLI source excerpts. Recovery used existing keyless deployer/debug access, with no new IAM grants, disk edits or helper resources.

## Controlled reproduction

On Linux x86-64, SDK 0.3.318/CLI 2.1.318 starts a real Monitor blocked on a FIFO. Killing its native process group and resuming the session generates the stopped notification and unrelated zero-turn, zero-queued-turn acknowledgment itself; no transcript is seeded.

`apps/orb-runtime/src/claude/orphan-monitor-native.test.ts` uses the production input queue and spawner with the actual SDK/native process. Named stdin and SDK-output gates deliver the acknowledgment while admitted human input is held. The regression releases that write after acknowledgment accounting, independently of shutdown. Before correction, acknowledgment accounting triggered `operation_drain`; subsequent `requesting` identified the human UUID, and the guard reported `claude_rotation_uncertain`. Output order is preserved; the gates select a cross-stream schedule. The metadata startup probe remains a test double. This demonstrates an accounting failure, not its natural frequency or the historical initial-close cause, which remains unknown. No deployment is authorized.

The fixture uses an owned loopback fake provider, dummy auth, isolated configuration and a seccomp network guard; no real subscription is used. Run: `npx vitest run apps/orb-runtime/src/claude/orphan-monitor-native.test.ts`.

Final hashed sources passed 15 scoped tests (2 reproduction/cleanup, 2 native handoff, 11 handoff DST), runtime typecheck and scoped Biome. Evidence under `.context/claude-rotation-93add73b/reproduction/`: `final-source-hashes.txt`, `final-ack-cancel-tests.log`, `final-ack-cancel-typecheck.log` and `final-biome.log`.

Private evidence: `.context/claude-rotation-93add73b/reproduction/`. Preserved first harness failures include malformed helper syntax, a wrong stub model, incomplete native-process-group termination, copying an active config temporary file, cross-query UUID/singular-field correlation, and requiring a `reason` property the transcript scanner does not emit. These are fixture failures, not evidence against the controlled mechanism.

## Correction (2026-11-05; local, undeployed)

Initial input now holds root ownership before asynchronous startup, including manual compaction. Successful settlement requires the input's result UUID echo; the existing 64-input cap exception requires every pending durable receipt. UUID-less errors cannot establish consumption or healthy completion: they cancel pending enqueue and follow supervised failure, without discarding accepted steering. Abort cleanup remains operation-scoped. Query identity fences stop old metadata callbacks from opening or failing a newer query; metadata resolving during graceful close cannot replace the initiating failure.

The native regression now requires the actual human-correlated result, successful operation terminal and idle health, with no rotation failure. Unit coverage includes startup acknowledgments, unrelated nonzero results, own-input zero-turn commands, singular/plural echoes, partial/capped steering, missing receipts, UUID-less errors/429, pre-SDK Abort, stale initialization and error/account/exit ordering. Deterministic startup/result/cancellation tests exercise 80 schedules. Older fake SDK success producers now explicitly echo their initial input; adversarial/unrelated results remain raw.

Fix evidence: `.context/claude-rotation-93add73b/fix/`. Native and focused RED preceded production edits. Additional RED regressions exposed cancellation cleanup and initialization-close ordering defects; their corrections are retained alongside GREEN logs. Earlier synthetic missing-echo fixtures caused expected timeouts; those producers were corrected rather than weakening assertions. A first new error-ordering harness awaited initialization while initialization awaited shutdown; its timeout is retained, and an explicit fatal-or-initialized observer made the same product failure deterministic. The later full-repository run found an independent lifecycle simulation failure, `resume-guard-three-attempts`, before unrelated remaining suites ran. Its trace `test-failures/resume-guard-three-attempts-1793921333077-0.json` was explicitly replayed unchanged before investigation; the new-human-resume assertion reproduces. No fix or full-suite pass is claimed. Exact final qualification is recorded in the PR; full E2E remains a CI gate. The historical first-close cause remains unknown. No deployment, target replay, prompt or persistent-state change.
