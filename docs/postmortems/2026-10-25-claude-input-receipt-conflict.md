# Claude input receipt proof conflict

2026-10-25 (PDT). Orb `f7d37f60-57e5-40d4-b3ce-90f676aaa232`; incarnation 3 image `pi-orb-image-v-6b3fee46-a3970ce816464c2d`. Authorized detached-disk capture established the conflict. Manual repair and Start restored running/idle and missing history, without deployment. Separate credential exposure during verification required exact-key revocation and physical replacement. `apps/orb-runtime/src/claude/history.ts` was unchanged between `6b3fee46` and investigated HEAD `0f00e298`.

## Observed sequence

| PDT | Evidence |
| --- | --- |
| 08:23:01 | `claude.rotation_failed`: root work raced query shutdown. |
| 09:56:26 | A new close-PR message wakes the failed orb. |
| 09:57:40 | Runtime ready; turn-resume recorded. |
| 09:57:45 | Message dispatched as steering. |
| 09:57:58.897 | User record `4bd7fe8e-f54e-40d9-aa07-225e5edbf11d`, inbox `d0c93124-d3d5-45ad-9fbb-6b0288032881`. |
| 09:58:08 | PR #17888 closed, independently confirmed with `gh`. |
| 09:58:15.904835 | Runtime fails `history_unavailable`: “Consumed Claude input receipt proof conflicts.” |
| 09:58:33 | Compute discarded. |

Replication ends before the tool result, despite the completed external action. A missing tail proves neither lost input nor duplicate execution.

## Established cause and limits

`ClaudeHistory.deriveInputReceipts` joins provenance to root queued attachments and subsequent `remove / absorbed_mid_turn` by input UUID/delivery ID. Scans reparse the complete root; failure publishes no new normalized tail.

The captured 1,188-line root contains two copies of one boot-only `isMeta` queued attachment:

| Original native line | Attachment UUID |
| --- | --- |
| 1158 | `cc344dfc-1e44-4be6-8e26-bf57111d9afb` |
| 1177 | `cc03e07a-cddc-4fca-9739-0c62684edd93` |

Both use `source_uuid: d397de97-7f9e-4999-b34c-d8575199a068` and delivery `956cc581-09d9-4781-a5b0-cba675caac76`. Payloads are equal; only native `uuid`/`parentUuid` differ. One matching removal appears at 1178. SDK 0.3.310's public parser associates removal with the **last** matching delivery attachment; the incident receipt guard rejected duplicate matches. The actual adapter scan reproduces the conflict with zero index commits.

Native source preserves source UUID/delivery ID across re-yield, a possible duplication mechanism; the initiating interruption and any first-party resubmission path remain unproven. Old boot receipt `f0de4648-499d-4913-bf80-67279c1ebc58` is not the conflict: its attachment/removal remain at 798/799 (session `ab7152fb-366b-4f5a-94dc-482b1da0f72b`, operation `d7b44c86-a695-46be-81cb-9a90de20c7dd`, delivery `0ea869d7-2948-4671-9760-b440a8eb3776`, attachment `4e030535-3b56-4eff-9d6c-f7a775482de4`). All 1,175 indexed native fingerprints, 3,854 public records and the one existing receipt are intact.

## Applied manual repair and recovery

User-approved suffix repair:

- Remove only uncommitted original line 1177.
- Reparent only original line 1179's `parentUuid` to the deleted row's parent, `947ba36e-90e2-4328-b1fc-b4e8a93d120b`.

The repair preserved the first 1,175 native lines, existing public records/receipt and every other native byte; index, provenance and session files were unchanged. Line 1158 remains on active ancestry; removal is preserved. Rejected: bare deletion breaks ancestry, leaving only two SDK messages; dropping `source_uuid` breaks native semantic identity/recovery deduplication.

Offline actual-adapter validation appends 13 records, including the missing tool result, final assistant and boot-input receipt. Repeat scans, reopening and an unrelated metadata append remain stable. SDK `getSessionMessages` returns equal ordered projections of 384 messages before/after repair. This excludes `isMeta`, proving neither provider-private context nor temporal equivalence: collapsing the duplicate changes host-meta count and consumption position, preserving human/assistant/tool payloads and order.

The final native assistant has `stop_reason: end_turn`; the pure boot planner returns settled/passive (`triggerTurn: false`). Same-lifetime recovery remains blocked; physical replacement qualifies retained handoffs through normal recovery, without ownership/state edits. Start verified this, not absence of future inference. All six validator/candidate tests (`final-validation-tests.log`) and 81 focused repository tests passed for the manual repair; these do not qualify the subsequent product correction.

Before mutation, normal read-write ext4 recovery verified all four original hashes. The exact native root was backed up outside SDK discovery at `/claude/repair-backups/ab7152fb-366b-4f5a-94dc-482b1da0f72b.pre-repair-20261025.jsonl`, root-owned mode `0400`, SHA-256 `c0d45e196125c6c23bad7eceb6675ad61c0c53fc8a615ae317ea740a22949372`. The approved root (SHA-256 `36825529d7179e81837ad6206eb3f9b8aad62fd30d42a3f2c3786b3bb244b47c`) was atomically installed and fsynced, owner `2000:2000`, mode `0600`. Index, provenance and session metadata were also unchanged.

After sync, unmount and detach, a read-only `noload` mount independently verified the repair under `/workspace/claude-f7d37-evidence/readback/`. Actual-adapter overlay `readback-report.json` verifies preservation of all 3,854 original records, the existing receipt and the 1,175-line committed prefix; repeat scan, reopen and unrelated append remain stable. SDK projection remains the same 384 messages, ending in `end_turn`.

Normal Start reached running/idle at 11:56:35 PDT on incarnation 4, VM ID `8801595363672977000`; stable at 12:01:36 PDT. Replication reached 3,871 records: the prior 3,852-record central prefix is exact, all 3,854 disk record IDs are present, and the tool result and final assistant are restored. The one additional `model_call` was historical catch-up from 09:58:17 PDT, not new inference. The host-restarted marker was passive; no new boot receipt is expected without a legitimate turn. Seven inbox messages are delivered, none pending; no messages were injected.

## Product correction

**Decision — 2026-10-25 (PDT); implemented locally, not deployed:** accept equivalent queued copies only with the same source UUID/delivery ID, deeply equal attachment payloads and one matching removal after every copy; use the latest copy. This is stricter than SDK global projection, which cannot alone prove causal consumption. Committed-receipt comparison is unchanged. Existing receipt proof identifies the selected native lines; existing typed errors report content-free rejection reasons. Algorithm and rationale: `docs/claude-agent-sdk.md`. No schema, persisted-state, prompt or concurrency changes; the manual repair and containment above/below are separate historical operations.

`pendingBootContext` now acknowledges boot `claude.input_receipt` by operation. Previously, host marker `d7b44c86-a695-46be-81cb-9a90de20c7dd` remained pending despite consumed inputs `f0de4648-499d-4913-bf80-67279c1ebc58` and `d397de97-7f9e-4999-b34c-d8575199a068`, allowing old context to be re-enqueued under a fresh UUID on a later human turn. This neither triggered startup inference nor blocked repair, and does not prove the duplicate's origin.

Qualification: test-first RED had four intended failures and 63 passes; final focused tests 74/74, all Claude tests 508/508 across 55 files, workspace typecheck and lint passed (existing warnings/infos only). The unchanged sealed 1,188-line original now scans successfully: 3,854-record prefix, existing receipt and 1,175 fingerprints preserved; 14 records appended, selecting original attachment 1177/removal 1178; repeat/reopen/unrelated-append stability verified. Evidence: `/workspace/claude-receipt-fix-logs/original-validation.log`. No raw production fixtures, provider inference or cloud writes. The first full-unit invocation reported execution transport failure after 301.8s despite explicit code-mode/Bash deadlines of 1,800s/1,740s; the failing hop is unknown and no assertion failure was recorded. `review-unit.log` is preserved. Full-unit and E2E results are recorded on the PR; E2E runs in CI (no local Docker daemon). No deployment requested.

## Operational logging and containment

During verification, an agent emitted unrestricted live GCE metadata containing the runtime bearer and Tailscale auth key, including nested `pi-orb-config` copies, into a private subagent tool transcript and operation-29 log. The 7,244-byte output was untruncated. Local operation-29 evidence was atomically redacted to field names/hashes; exact-value scanning found zero remaining matches there. Evidence directories are mode `0700`, files `0600` or `0400`. The transcript cannot be erased. No external access is known; absence is unproven. Do not reopen raw material; use only `credential-exposure-sanitized.json` and `credential-exposure-keys.json`.

Inspector VM `5770055919709975511`, its 10 GB boot disk and firewall `1487454508865024837` were deleted; exact absence verified. Inspector SSH key removed. Target data disk `5363734713379935878` remains 50 GiB, attached solely to incarnation 4.

At 12:05:27 PDT, an operator verified Tailscale key ID `k582qif36921CNTRL`, description `pi-orb f7d37f60-57e5-40d4-b3ce-90f676aaa232 i4` and `reusable: false`, then deleted only that key. DELETE returned 200; verification GET returned 200, not the expected 404, so operations stopped. A separately approved read-only GET established retained-record semantics: `invalid: true`, `revoked: 2026-10-25T19:05:27Z`. No second DELETE occurred. Consumption was not assumed: retained tailscaled identity can resume without consuming a new key. Only the named Secret Manager Tailscale OAuth credential was read, in memory; OAuth scope was `auth_keys`, with no device mutation or key listing. First failure and final invalid-key proof remain private.

After fresh idle/zero-pending checks, normal Stop was accepted at 12:07:03 PDT; stopped was observed at 12:07:33. The exact old VM `8801595363672977000` was externally deleted with `--keep-disks=data`, preserving data disk `5363734713379935878`; its owned boot disk `3467826584309984872` auto-deleted and absence was verified before Start. Normal Start at 12:08:29 created physical VM `2663529091242913088` and boot disk `8785185302952275264`, still logical incarnation 4. Running/idle was observed at 12:09:35. Memory-only old/new bearer digests differ; the durable provisioning edge records `reason=host_absent token_rotated=true`. Plain Stop/Start alone would retain the bearer. No manual incarnation, database, ownership or session edits were used for containment; the new enrollment key was not exposed.

At 12:10:34 PDT, replication held 3,874 records with the prior 3,871-record prefix exact and all 3,854 original disk record IDs present, including the tool result and final assistant. Only MCP, cost-state and passive host-restarted metadata were added; no new model/request events or pending inbox inputs appeared. The old Tailscale key remained invalid/revoked; data attached solely to the fresh VM. Inspector, boot disk, firewall and SSH-key cleanup were reverified; originals/backups retained.

The existing keyless `pi-orb-amp-deployer@playground-dev-6ae7.iam.gserviceaccount.com` account passed a read-only preflight, was restored as active, and only the temporary `mark@heyglide.com` gcloud login was revoked. Final resource and running/idle application checks passed through the restored account; no trust or IAM changes were made.

Operational inspections must project a safe field allowlist before output/logging; privacy and later redaction do not undo transcript exposure.

## Retained evidence

The source workspace disk is `pi-orb-data-f7d37f60-57e5-40d4-b3ce-90f676aaa232`, ID `5363734713379935878` (50 GB). Authorized read-only capture preserved originals and a manifest under private `/workspace/claude-f7d37-evidence/`; reports, source evidence and logs are under `validation/`.

Captured files: `claude/session.json`, `claude/provenance.json`, `claude/index.json` and the native session JSONL. Native history remains resume authority; normalized history is not a replay source. Workspace evidence remains private, not a durable public archive. Only sanitized findings appear here, not prompts/tool payloads. The earlier quota/handoff incident in `docs/postmortems/2026-10-24-claude-terminal-failure.md` does not establish the duplicate's generation mechanism.
