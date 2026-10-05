# Workspace full, then history desync — 2026-10-04

Affected orb: `00b5f77d-aaaf-4ae3-8f00-894581416589`.

## Observed

- `/workspace`: 50 GiB, zero bytes available; inode usage 58%. Boot disk usage 26%.
- Isolated Docker VFS build cache: 40.35 GiB.
- Supported builder prune plus failed-snapshot cleanup freed 43,298,664,448 bytes; subsequent `df` reported 40,614,227,968 bytes available.
- Incarnation 4 failed `session_load_failed` with `ENOSPC`.
- Incarnation 5's runtime-loaded head was `b9f69171`, six records behind replica cursor `5aac75bd`; history pull failed `cursor_not_found`. This was loaded-head evidence, not the final disk comparison's missing-record count.
- Native records remained preserved in the control-plane replica; the 2026-10-04 diagnosis made no changes. Offline session recovery completed on 2026-10-05, followed by normal replication without direct SQL modification.

## Read-only comparison — 2026-10-04 (America/Cancun)

The automated diagnostic run compared a fresh native replica export with a byte-preserving copy from retained disk `4884649171842372773`, attached read-only to disposable compute and mounted `ro,noload`. The target orb was never started and history was unmodified; disposable compute was deleted and the retained disk left READY and unattached.

- Session bytes: 11,242,537; SHA-256 `181e3361fd8596ca44e7bfbbfc4a943f1469f5a19bca1310d828092ac02eaa79`.
- Session headers match. Disk has 1,927 parseable entries; replica has 1,928. Their first 1,924 normalized records match, through `2c5abde1`; no shared-record content divergence.
- Line 1,926 is a 2,289-byte truncated JSON object for `6bc496a2`, followed by three valid later entries. This is not merely an unterminated final line.
- Replica-only parseable chain: `6bc496a2` → `08ca68db` → `a5d8c658` → `5aac75bd`.
- Disk-only incarnation-5 restart branch from last common `2c5abde1`: `46db26fa` → `1d916b64` → `5d8d1bba`, written at 2026-10-04 19:53:12 America/Cancun.
- Both replica pointers name `5aac75bd`, absent locally. Neither parseable graph has duplicate IDs or missing parents; the selected replica ancestry cannot be reconstructed from disk.

Evidence and JSON report: `/workspace/evidence/history-diagnosis-00b5f77d-2026-10-05/` on diagnostic orb `fb99ed0e-47b0-47b4-a0fc-508335566eff`.

## Authorized recovery — 2026-10-05 (America/Cancun)

Reconciliation is conceptually a rebase: verified common parent `2c5abde1` has replica tail `6bc496a2` → `08ca68db` → `a5d8c658` → `5aac75bd` and disk restart-only tail `46db26fa` → `1d916b64` → `5d8d1bba`. The implemented linear recovery replaces the truncated raw line with the intact replica native entry, restores all four replica entries before the three restart entries in append order, and reparents **only** `46db26fa` from `2c5abde1` to `5aac75bd`, retaining IDs and later parent links. This is permissible only after verifying every affected restart ID is absent from the **full SQL replica** (CLI export contains only the selected chain) and has no other durable references: already-replicated records are immutable; existing ID content must not change. Preserve original raw inputs/backups, validate native payload redactions, links and tool-result matching, distinguish active head from append cursor, and atomically checkpoint verified persisted records. The user explicitly authorized an offline recovery operation in the existing diagnostic tool. This is not automatic reconciliation: `--recover --offline` requires complete operator-attested SQL proof, candidate review and exclusive offline ownership; default diagnosis remains read-only. The tool-specific no-tests waiver now includes recovery, with static checks and manual candidate/refusal validation instead. Interface and guards: `docs/history-replication.md`.

### Offline tool validation — 2026-10-05 (America/Cancun)

Using the frozen original session and fresh native export/full SQL proof, the tool produced an external candidate with SHA-256 `d2d7501e205bef19f9b277842221018a8d3f538fd1a4f03fe2122d72d08b63a4`. Exact header/common bytes and D2/D3 bytes match the original; D1 differs only in parent. The four restored IDs and final D3 ancestry pass strict parsing and production mapping. Candidate review evidence: `/workspace/evidence/manual-recovery-report-reviewed.json`, `/workspace/evidence/manual-recovery-candidate-reviewed.jsonl`, `/workspace/evidence/manual-recovery-backup-reviewed/`.

Manual invocations refused incomplete/count-mismatched/live SQL proof, an extra SQL branch, unexplained malformed bytes and legacy session format, with exit 2 and typed reasons preserved in `/workspace/evidence/manual-recovery-refusals/`. Typecheck, lint and help validation passed. A fresh byte-preserving session copy produced the same candidate hash (`/workspace/evidence/fresh-recovery-report.json`). A manually invoked atomic apply on a disposable local copy preserved uid/gid `2000:2000`, mode `0640`, and that candidate hash (`/workspace/evidence/manual-atomic-report.json`). This disposable-copy validation preceded target application.

### Completed repair — 2026-10-05 (America/Cancun)

The tool atomically applied candidate SHA-256 `d2d7501e205bef19f9b277842221018a8d3f538fd1a4f03fe2122d72d08b63a4` to the offline target session: restored four records, removed malformed line 1,926, and reparented only `46db26fa` from `2c5abde1` to `5aac75bd`. Target uid/gid `2000:2000` and mode `0600` were preserved. Snapshot permission was denied; the fallback preserved all raw external byte backups with tool fsync. Rescue compute was cleanly unmounted and deleted; the data disk was retained.

No SQL was modified directly. After Start at 06:20:32.446 America/Cancun, normal replication registered all three local-tail IDs with exact parents: `46db26fa` → parent `5aac75bd`, `1d916b64` → parent `46db26fa`, `5d8d1bba` → parent `1d916b64`. At 06:22:03 the orb was running with 1,936 records and cursor = head `5ae1cc29`; all 1,928 original SQL rows were unchanged, no original IDs were lost, and all four restored records retained full native payloads on the selected chain. A later native CLI export had 1,938 records and cursor = head `89c9f064`, normal live growth rather than a frozen-snapshot comparison. At 06:23:53 the parent resource reported running, state version 55. Boot workspace free space was 40,614,146,048 bytes (37.8 GiB).

Verification: `/workspace/evidence/history-recovery-00b5f77d-2026-10-05/post-start/verification.json`. External byte backups (`live-artifacts` and tar) and post-start reports remain under `/workspace/evidence/history-recovery-00b5f77d-2026-10-05/` on the diagnostic orb; target durable report: `/workspace/evidence/history-recovery-2026-10-05.json`. No tests were run under the tool-specific waiver.

## Interpretation and limits

The comparison confirms a truncated persisted record and divergent subsequent chains, explaining `cursor_not_found`: replica cursor `5aac75bd` is not in the parseable disk session. SDK in-memory append preceding a durable write while the workspace was full remains the likely mechanism; the comparison alone does not prove the write sequence or repair safety.

Freeing capacity did not reconcile history. Preserve both sources. Do not open the evidence with SDK SessionManager: its loader can modify/migrate session files.

The existing **Close the served-vs-durable persistence gap** item in `TODO.md` owns hardening; this incident adds evidence, not another work item. Earlier mechanism evidence: `docs/postmortems/2026-08-03-cursor-not-found.md`.
