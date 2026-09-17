# Typed-history migration ran without fencing legacy runtimes

## Incident

Deploy [35168145109](https://github.com/schani/pi-orb/actions/runs/35168145109) applied `022_typed_history_fields.sql` at `2026-09-17T01:38:06.336Z` without first stopping running orbs, contrary to `docs/pi-adapter.md`. A legacy `1fcc261` runtime continued writing after the one-time backfill. The new domain and UI read only normalized fields, so any later legacy-shaped row could be incomplete to clients.

The automated release itself completed with durable outcome `validated` at `01:53:47Z`; GitHub completed at `01:53:59Z`. That verdict covers its encoded gates, not the omitted fleet writer fence. The rollout is deployed but not fully qualified.

## Evidence and impact

A read-only assessment at `01:57Z` found six live GCE-backed orbs: one running legacy `1fcc261` runtime (`056e8233…`, generation `1789594045`), three legacy `d110990` VMs still `archiving`, and two new `ec81e80` runtimes. The running legacy runtime inserted 44 rows after migration 022; the archiving runtimes inserted none.

The exact 022 predicates initially found zero missing shell, custom, subagent, inbox, failure, or patch projections among 119 post-migration rows in the bounded six-orb set at `01:57Z`. That result was valid at its cutoff, not a writer fence. Five later parent-orb edit-tool calls then persisted a native edit diff without top-level `patch`.

A fresh read-only check at `2026-09-17T02:19:49.331Z` found 117 post-022 rows for `056e8233…`: five missing patch projections and zero missing projections for each of the other five kinds. Each affected row has native patch data, so the rows are repairable with no observed native-data loss. The three legacy archiving orbs still had zero post-022 rows. The normalized historical inbox proof found zero non-delivered messages for every inspected orb. No runtime was stopped or repaired during either assessment.

A second repair condition exists for inbox rows. Migration 022 only adds `history_records.record.inboxMessageIds` (`apps/control-plane/src/adapters/pg/migrations/022_typed_history_fields.sql`). Normal replication marks `orb_messages` delivered only from the records in the current commit (`apps/control-plane/src/adapters/pg/store.ts`, `commitPullBatch`); a duplicate runtime acknowledgement can leave them `delivering` (`noteOrbMessageDelivery`), and lifecycle reconciliation does not rescan historical records (`apps/control-plane/src/domain/lifecycle.ts`). Therefore zero missing projections alone does not prove inbox delivery state is repaired.

Migration 023 applied at `01:38:25.184Z`. All three existing projects received verified owner `53da7ad4-6c53-4223-868e-0641bb4bcdd9`; project metadata was otherwise unchanged. The one personal-instructions row retained exact content hash, revision, and timestamp. The three `PI_ORB_ORIGINAL_*` bootstrap variables were removed after this verification; `PI_ORB_USER_ID` remains for future smoke selection.

## Cause

The stop-before-backfill requirement existed only as an operator instruction. Neither release preflight nor migration execution enumerated and rejected old runtime writers. Release preparation missed the manual step, while the durable result correctly reported success for every gate the workflow actually contained. The original recovery analysis also equated projection repair with complete repair; migration 022 has no `orb_messages` delivery side effect, so that conclusion did not follow.

## Recovery plan (not executed)

Recovery needs either an executor independent of `056e8233…` or a dashboard stop/start. An agent cannot stop its own runtime and continue; no self-stop was performed during assessment.

1. Before another message, stop and start `056e8233…` through the dashboard. Verify the old VM is `TERMINATED`; retained-workspace replacement must adopt generation `1789608844` and image `pi-orb-image-v-ec81e80-0d871be33fdc4dba`.
2. Let the three archival workflows finish before the global repair; their service Stop returns `409` while archiving. Do not bypass lifecycle ownership with raw GCE stops.
3. From the replacement, re-inventory all live hosts and prove no pre-`ec81e80` writer remains. At a recorded cutoff, repeat the exact six missing-projection counts and count non-delivered `orb_messages` for which normalized historical `record.inboxMessageIds` proves delivery. Scope that proof by joining `history_records.orb_id`/typed message ID to `orb_messages.orb_id`/`message_id`, restricted to the expected affected legacy orb IDs. Do not derive proof with ad hoc TypeScript over legacy JSON.
4. Replay migration 022 to repair the five known patch fields. If the final inbox inspection finds proven delivery rows, reconcile them in the same transaction. Update only joined proof rows to `status = 'delivered'`, `auto_start = false`, `last_error = NULL`, and `updated_at = now()`, mirroring `commitPullBatch`; never issue a blind status update. Log both repair row counts. Do not rerun 023, alter its marker, or rewind the replication cursor.
5. Verify all six missing-projection counts and the scoped proven-non-delivered count are zero before admitting further work.

Migration 022 replay repairs stored projections because replication rejects a changed existing record as `record_conflict`. It is insufficient alone for affected inbox IDs: historical records are not fed back through `commitPullBatch`.

## Rules

- A one-time data-shape backfill must prove incompatible writers are fenced before schema mutation and remain fenced through verification.
- Release evidence distinguishes encoded gate success from omitted operational preconditions.
- Bounded zero-defect queries are evidence for their named set and cutoff only.

Assessment artifacts: `.context/deploy-35168145109/runtime-fence/`. Follow-up work is tracked in `TODO.md`.
