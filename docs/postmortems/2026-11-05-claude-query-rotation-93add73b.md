# Claude premature query shutdown: 93add73b

2026-11-05; times PST. Orb `93add73b-2895-4000-8a7a-1eaf6372e8b6` failed `claude_rotation_uncertain`.

## Evidence and limits

At 14:04:35, a stopped background-task notification preceded a human question. The retained native transcript contains the completed answer at 14:04:43.225; the local index records `claude.rotation_failed/root_work` at 14:04:43.717, after a successful zero-turn result with no queued turns. Final child/task/handoff inventories were empty.

The historical first-close trigger remains unknown: that image could replace its last-result diagnostic during closing. Adjacency does not establish that the stopped notification caused shutdown. The preceding host interruption was audited Spot preemption, not deployment replacement.

A controlled SDK 0.3.318/CLI 2.1.318 reproduction starts a genuine Monitor blocked on a FIFO, kills its owned process group, then resumes the session. Native recovery generates an orphan notification and a successful zero-turn result without either user-UUID echo. Gating the admitted human stdin write until acknowledgment accounting reproduces premature shutdown on the baseline, followed by human-correlated requesting and rotation failure. This proves the accounting defect, not its historical occurrence or natural frequency. The metadata startup probe and loopback provider are test doubles; operation input, SDK/native process and transcript recovery are real.

## Correction

A successful zero-turn result without singular or plural input UUIDs leaves root completion unchanged. Pending steering or queued turns still hold the root; owned local-command results, errors, positive-turn results and background handoffs retain their existing handling. The synchronous operation claim already protects pre-enqueue startup and compaction.

An acknowledgment suppressing completion of an active root without owned work enables existing bounded `claude.continuation.root_result` and changed-decision diagnostics. Completed roots held by hooks are not resurrected. No prompts or new persisted fields.

Focused baseline RED and explicit DST replay precede the correction. The private native reproducer passes against the narrow patch: orphan acknowledgment, then the human-correlated result, successful operation terminal and idle health, without rotation failure. Unit/DST coverage checks pre-enqueue startup, compaction, both UUID shapes, errors and hook-held completed roots.

## Recovery and preservation

Read-only retained-disk inspection found all three inbox deliveries durably consumed, the completed answer and no remaining ownership. Source hashes, inspection receipts and cleanup proof remain in private evidence. No disk/history/task edits were needed.

User-authorized ordinary startup at 14:47:47 recovered incarnation 1 by 14:49:12, including the missing final answer and failure event. The session returned idle with unchanged delivery receipts and no observed automatic inference. This establishes startup recovery, not correction of the race.

Private evidence: `.context/claude-rotation-93add73b/{retained,recovery,reproduction,trim}/`; reproduction details: `reproduction/RESULTS.md`. No deployment or further target action.

The baseline `resume-guard-three-attempts` blocker was a fixture premise: the idle reaper legitimately beat recovery before hidden human input became observed activity. The fixture now reconnects its visible tab after each recovery; focused scenario and lifecycle DST gates pass. Original trace `test-failures/resume-guard-three-attempts-1793921333077-0.json` and failed cleanup-only attempt remain preserved; corrected replay diverges on activity refresh, not a passing replay. See `docs/testing.md` and `.context/pr267-babysit/resume-guard/`; baseline evidence remains in `fix/dst-failure/`. Scoped qualification does not establish a full-suite pass. Full E2E remains required before deployment.
