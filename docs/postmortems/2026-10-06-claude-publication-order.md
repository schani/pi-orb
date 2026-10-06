# Claude native-prefix publication blockage

## Evidence (2026-10-06)

Exact-main CI37418896284 failed manual continuation with `claude_stream_identity_gap` after native exit and SDK EOF. Its final native rows were not captured: the observer depended on a readiness-gated snapshot. Empty captured rows do not establish missing disk history.

A first closed-provider diagnostic observed a native-only recovery assistant (`stop_sequence`) before the continuation assistant (`end_turn`), but awaited capture before result and invoked snapshots; its trace exceeded the existing cap. A subsequent snapshot-free passive probe retained 26 checkpoints / 65,620 bytes, no discarded checkpoints. It passed and published the recovery prefix before streamed blocks. Neither attempt proves CI's ordering.

Rejected: stale in-flight reads. `HistoryFiles.read` is synchronous; every scan reads fresh bytes. Post-exit scans contained newer rows and the exact streamed assistant UUID. No read-cache, shutdown, retry or timeout fix is justified.

## Controlled proof and correction

The corrected deterministic adapter reproduction appends recovery assistant A after B's live blocks start, then appends durable assistant B with the exact streamed UUID before exit. Fresh final scans contain B, but publication stops at unmapped A forever; terminal drain fails closed. Publishing A before blocks is the passing control.

Lookahead now permits native-only prefixes only if **every** remaining live block is owned by a UUID in `messageBlocks` and each UUID is an exact durable **assistant** message in the current scan. Publication preserves native order; only the matching record retires its own blocks. Already-published retirement is unchanged. Missing/mismatched UUIDs, wrong-role matches and unbound blocks still hold/fail closed. Current invariant: `docs/claude-agent-sdk.md`.

No inferred block ownership, changed source order/UUIDs, synthetic IDs, recovery-row omission, retries or new state machine. Existing visible identity-gap health and retained blocks diagnose rejected schedules; ordered frames and exact retirement IDs demonstrate accepted publication.

## Local validation and limits

Evidence root: `.context/consolidation/main-qualification-20261006/continuation-failure/`. Original CI evidence, initial/corrected private probes and their first failures remain preserved. The first expanded regression also omitted the existing terminal platform record from its expected sequence; corrected expectations preserve that record. Initial unbound controls mistakenly placed all blocks before assistant correlation, which binds every current stream block regardless of content; corrected controls use missing identity or a new unbound block after correlation. A later fixture simplification omitted the selected Opus model and failed all eight attach assertions; restoring that required metadata corrected the setup. Those logs remain under `publication-fix/`. Final whole-suite validation exposed a stale drain-test stub missing the health-independent `sessionId()` method; a retained-fixture IPC diagnostic confirmed the resulting `TypeError`. Adding that method corrected the fixture without changing worker behavior or deadlines. First failure and diagnostic evidence: `.context/consolidation/claude-publication-fix-20261006/`.

Ordinary regressions cover early/late prefixes, fully bound multiple blocks, missing/mismatched UUIDs, wrong-role durable matches and partially/fully unbound blocks, ordered records and exact retirement IDs. Focused unit/DST/native fixture run passed 153 tests; capture/receipt tests passed 4; runtime typecheck passed. Genuine pinned-SDK/native closed-provider acceptance passed all checks, including manual continuation, with loopback-only network isolation and no outside billing. Owned scratch was removed; disk remained 4 GiB free. No new DST failure/trace was generated.

Fixture capture uses health-independent session identity and no observer snapshot/flush; compact limits are unchanged. The original CI schedule remains unknown; controlled proof establishes a concrete valid-schedule defect, not retrospective attribution. The two unrelated historical lifecycle waivers remain valid, not resolved. Standing deployment authorization is GitHub Actions only, after reviewed PR qualification and exact merged-main CI/E2E gates. This fix requires parent review before merge; no deployment has run.
