# Claude Workflow child retirement gap

2026-10-15, PDT. Read-only production investigation; no restart/state edits.
[Orb cca19ddc-e8ff-45ba-a3b2-5e8d65e3b851](https://pi-orb-issuer-1077475695242.us-central1.run.app/orbs/cca19ddc-e8ff-45ba-a3b2-5e8d65e3b851), session `9703ef30-28a6-4e73-abd2-edce690786a8`.
Query `7e65ac55-8c3f-4186-bcf7-0858e1f88fd3`, operation `bea215f3-fa23-4d9f-979b-33ad0e8e47f2` stayed busy after successful final reply; tasks/handoffs were empty but 829 children remained owned.
All 829 IDs had successful results across 18 Workflow journals; no child IDs matched the 50 task notifications. Workflow invokes runner `aC` directly, admitting children without ordinary Agent task registration.
Exemplar `a1caa89aa923240ee`: `wf_72343f08-75d/journal.jsonl` lines 130/132; root task `wbifgz4dy` was the parent, not that child.
SDK 0.3.300 / CLI 2.1.300 production/local executable SHA-256: `674deba0bba9aee479f4503c438b49303b6fdd304b9a471b14977aaec5215453`.

Decision: complete successful `result` is authoritative after awaited `aC` and cleanup (`Qt(await Sr)`, result append offset 238064107); started appends are asynchronous (238047358) and add no proof. Failed records do not invalidate success; cleanup alone does not establish admission freshness.
Rejected parent-only tracking: script completion/abort races only the returned promise, not detached `agent()` cleanup. Query EOF also does not await detached children, so independent child admission must remain.
Prior supervised process exit fences successor admission; same-process duplicate-ID exclusions and preexisting-result baselines prevent stale proof reuse. Generic shutdown/history fences remain independent.

Original genuine native RED at 19:21 PDT admitted `acfd49db2f3dde6d3`; only parent `ws1b53ne3` received task bookends. Foreground Agent control released ownership; dummy auth, loopback provider and seccomp excluded external inference.
Evidence archive: `.context/claude-workflow-ownership/` retains original RED/control logs, source offsets, qualification attempts and runners; `redesign/before/source.tar.gz` freezes HEAD `0d28de4b` with all four previous feature tests. First traces remain unchanged in `test-failures/` and `redesign/traces/`.
Result-only RED: `redesign/standalone-reader-red.log` rejects standalone success; `redesign/current-child-red.log` retains its current child. Explicit replay in `redesign/current-child-red-replay.log` reproduces trace `claude-workflow-result-current-result-1792120819847-0.json` before correction; `redesign/current-child-green-replay.log` passes after correction.
Dedup RED/green and the first typing failures remain in `redesign/dedup-red.log`, `dedup-focused.log`, `typecheck-first.log`; source-proven snapshot-only correction is locally validated, not deployed.
Earlier sync-cut trace `claude-workflow-race-sync-1792118897872-4.json` was replayed: the cut hit pending hook-history sync, not Workflow proof. Failure cuts now arm after root receipts; evidence and replay runners remain archived.

Contract: `docs/claude-agent-sdk.md`. Current validation scope: `docs/testing.md`; local correction is undeployed, with no protocol/schema/persisted-field changes.
