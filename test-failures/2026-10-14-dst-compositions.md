# DST boundary compositions — evidence

2026-10-14, America/Los_Angeles; test-only, undeployed. No product bugs or production edits.
Base: `a60f497b609f4f1ef0a8eabc81a0c9c52f0f0f1d`; branch: `test/dst-boundary-compositions`.
[PR #97](https://github.com/schani/pi-orb/pull/97) merged after 11 green checks. Shared `npm ci` exited 0.

[Evidence archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/087158de-a85f-4594-8e0f-99270f568805/dst-boundary-compositions/evidence.tar.gz)
SHA-256: `ad390b5e56ba61168988c6dedb627a6d50b33ac58e26b462b6a097668b45d649`.
138 files: 110 author files, 18 root first-failure traces (12 poll, six detail), four frozen source snapshots, three shared provenance files, inventory/replay/checksum manifests.
All 137 payload checksums verified after extraction. `INVENTORY.json` inventories/hashes all four author directories; originals remain untouched.
Archive v1 preserves pre-review fixtures; snapshots are author-phase, not final test qualification. Final sources/checks belong to the new PR code/body; parent validation and unrelated #97/audit/auth evidence are excluded. No raw trace/log/snapshot is added to Git.

## Coverage and classifications

Poll: 12 × 20 = 240 schedules; actual poll/reconcile lanes + `HarnessAgentPlane`, mixed Pi/Claude, commit-before/lost-ack/real CAS, Stop/delete/fresh `ControlState`.
Atomic records/cursor/receipts, FIFO, sibling progress, no overlap/resurrection; drained restart, not abrupt death; memory, not PostgreSQL cascade/native SDK proof.
Writer grammar: 41 schedules (one forced held span + 40 raced), real writer/JSON/reducer critical-prefix oracle, valid multi-operation append/replace/tool/history retirement; same-key output/tool revisions straddle a nonretiring `history.record` to witness its coalescing fence.
Overflow: 36 schedules, actual client retry + `computeSyncFrames` + reducer/cache + retired callbacks; mock socket, not real socket/browser.
Detail: three terminal cases × 80 = 240 schedules; real `RunningBody`/`DetailLoader`, scoped pool/determined timers, independent retry/response/owner/connection actors.
Real `CommittedBody` stale-owner/invalidation denial and current cache admission; pinned witnesses precede mixed actors; hook harness/mock HTTP, not ReactDOM/E2E.
Counts do not imply unique iterations or exhaustive failures. Existing telemetry is asserted; no new events needed.
Poll fixture 1: memory inbox survives deletion unlike PostgreSQL cascade; corrected to assert late-commit nonmutation.
Poll fixture 2: `hostStateOf` throws after destruction; corrected to assert `hostCount === 0`. All 12 explicit red replays preceded fixes.
Detail fixture 1: stale scope attributed to remount key; observe actual loader-call key. Fixture 2: actor block misplaced outside `runTasks`.
Both detail issues: three explicit red replays before each correction; archived `.context/dst-compositions/detail/receipt.md` explains attribution.
Corrected-prefix detail replays exhaust truncated traces, NOT green replays; fresh schedules pass. Author focused logs are retained; broader checks belong in the parent PR body.

[Mutation archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/087158de-a85f-4594-8e0f-99270f568805/dst-boundary-compositions/sensitivity.tar.gz) (baseline `f643f26`): new compositions killed three mutants; publication-guard removal survived, but failed the byte-identical inherited control. Remaining coverage: `TODO.md`.
SHA-256: `4b9314677315052f48e147aacf6500b9cb8d5535466199510690ebd56c1be529`; all 55 original payload hashes verified after extraction; originals retained.

## Replay

Use an isolated checkout of the exact base and `npm ci`; archive `REPLAY.md` maps every trace/selector to its preserved red snapshot and gives fresh-schedule commands.
Pattern: install the mapped snapshot at its original test path, then `DST_REPLAY="$ARCHIVED/test-failures/<trace>.json" npx vitest run <test-path> -t '<mapped-selector>'`; never overwrite active tests.
